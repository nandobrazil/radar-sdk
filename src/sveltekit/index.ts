import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Handle, HandleServerError, RequestEvent, RequestHandler } from '@sveltejs/kit';
import type { RadarClient } from '../client.js';
import { requestIdFrom, runWithContext, type RadarContext, type RequestLike } from '../context.js';
import type { RedactMode } from '../options.js';
import { LIMITS, type ExceptionInfo, type StackFrame } from '../protocol/index.js';
import { radar } from '../radar.js';
import { maskValue } from '../redact.js';
import { redactUrl } from '../request.js';
import { truncate } from '../serialize.js';
import { parseBrowserStack } from '../stack.js';

export { composeServerSourceMaps, moveClientSourceMaps } from './sourcemaps.js';

export type RadarHandleOptions = { client?: RadarClient; requestId?: (event: RequestEvent) => string | null | undefined };
export type RadarHandleErrorOptions = { client?: RadarClient };

export type ClientErrorsOptions = {
  clientDir?: string;
  sourceMapsDir?: string;
  maxPerMinute?: number;
  maxGlobalPerMinute?: number;
  maxBytes?: number;
  client?: RadarClient;
};

type ReportedAction = { kind: 'click' | 'submit'; element: string; label: string; msBefore: number };
type ClientErrorReport = { name: string; message: string; stack?: string; path: string; action?: ReportedAction };

const ACTION_KINDS = new Set(['click', 'submit']);
const ACTION_ELEMENT = /^[a-z][a-z0-9-]{0,23}$/;
const MAX_ACTION_LABEL = 80;
const MAX_ACTION_DELAY_MS = 60_000;

const CREDENTIAL_IN_TEXT = /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const MAX_STACK_LENGTH = 16_000;
const MAX_TRACKED_ADDRESSES = 10_000;

function clientAddress(event: RequestEvent): string | undefined {
  try {
    return event.getClientAddress();
  } catch {
    return undefined;
  }
}

export function routeName(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  return id.replace(/\/\([^)/]+\)/g, '') || '/';
}

function contextFor(event: RequestEvent, chooseRequestId?: RadarHandleOptions['requestId']): RadarContext {
  const path = `${event.url.pathname}${event.url.search}`;
  const ip = clientAddress(event);
  const req: RequestLike = {
    method: event.request.method,
    url: path,
    originalUrl: path,
    params: event.params,
    query: Object.fromEntries(event.url.searchParams),
    headers: Object.fromEntries(event.request.headers),
    ...(ip ? { ip } : {}),
  };
  const route = routeName(event.route.id);
  const chosen = chooseRequestId?.(event);
  return { requestId: requestIdFrom(chosen || event.request.headers.get('x-request-id')), startedAt: performance.now(), req, ...(route ? { route } : {}) };
}

function withRequestId(response: Response, requestId: string): Response {
  try {
    response.headers.set('x-request-id', requestId);
    return response;
  } catch {
    try {
      const copy = new Response(response.body, response);
      copy.headers.set('x-request-id', requestId);
      return copy;
    } catch {
      return response;
    }
  }
}

export function radarHandle(options: RadarHandleOptions = {}): Handle {
  const client = options.client ?? radar;
  return async ({ event, resolve: resolveEvent }) => {
    let context: RadarContext;
    try {
      context = contextFor(event, options.requestId);
    } catch {
      return resolveEvent(event);
    }
    const req = context.req as RequestLike;
    return runWithContext(context, async () => {
      let response: Response;
      try {
        response = await resolveEvent(event);
      } catch (error) {
        if (client.shouldLogRequest(req)) client.logHttpRequest(context, 500);
        throw error;
      }
      const tagged = withRequestId(response, context.requestId);
      if (client.shouldLogRequest(req)) client.logHttpRequest(context, tagged.status);
      return tagged;
    });
  };
}

export function radarHandleError(inner?: HandleServerError, options: RadarHandleErrorOptions = {}): HandleServerError {
  const client = options.client ?? radar;
  return (input) => {
    const unexpected = (input.status ?? 500) >= 500;
    try {
      if (unexpected) client.captureError(input.error);
    } catch {
      return inner?.(input);
    }
    if (inner) return inner(input);
    if (unexpected) console.error(input.error);
    return undefined;
  };
}

class WindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size >= MAX_TRACKED_ADDRESSES) this.prune(now);
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return this.max > 0;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    if (this.hits.size >= MAX_TRACKED_ADDRESSES) this.hits.clear();
  }
}

async function readLimited(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function parseAction(value: unknown): ReportedAction | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { kind, element, label, msBefore } = record;
  if (typeof kind !== 'string' || !ACTION_KINDS.has(kind)) return undefined;
  if (typeof element !== 'string' || !ACTION_ELEMENT.test(element)) return undefined;
  if (typeof label !== 'string') return undefined;
  if (typeof msBefore !== 'number' || !Number.isInteger(msBefore) || msBefore < 0 || msBefore > MAX_ACTION_DELAY_MS) return undefined;
  return { kind: kind as ReportedAction['kind'], element, label: label.replace(/\s+/g, ' ').trim().slice(0, MAX_ACTION_LABEL), msBefore };
}

function actionAttrs(action: ReportedAction | undefined, mode: RedactMode, routeOnly: boolean): Record<string, string | number> {
  if (!action) return {};
  const attrs: Record<string, string | number> = { 'ui.action': action.kind, 'ui.element': action.element };
  if (!routeOnly && action.label) attrs['ui.label'] = mode === 'mask' ? maskText(action.label) : action.label;
  attrs['ui.msBefore'] = action.msBefore;
  return attrs;
}

function parseReport(text: string): ClientErrorReport | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const name = optionalText(record.name, 200);
  const message = optionalText(record.message, LIMITS.messageLength);
  const stack = optionalText(record.stack, MAX_STACK_LENGTH);
  const path = optionalText(record.path, 2000);
  if (name === null || message === null || stack === null || path === null) return null;
  if (!message && !stack) return null;
  const action = parseAction(record.action);
  return { name: name || 'Error', message: message ?? '', ...(stack ? { stack } : {}), path: path?.startsWith('/') ? path : '/', ...(action ? { action } : {}) };
}

function maskText(text: string): string {
  return text.replace(CREDENTIAL_IN_TEXT, (match) => maskValue(match));
}

function remoteFrame(frame: StackFrame, file: string): StackFrame {
  return { ...frame, file, inApp: false };
}

function localFrame(frame: StackFrame, clientDir: string, mapFor: (file: string) => string | null, routeOnly: boolean): StackFrame {
  let url: URL;
  try {
    url = new URL(frame.file);
  } catch {
    return remoteFrame(frame, 'browser');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return remoteFrame(frame, 'browser');
  const page = routeOnly ? url.origin : `${url.origin}${url.pathname}`;
  if (!url.pathname.startsWith('/_app/')) return remoteFrame(frame, page);
  let candidate: string;
  try {
    candidate = resolve(clientDir, `.${decodeURIComponent(url.pathname)}`);
  } catch {
    return remoteFrame(frame, page);
  }
  const map = candidate.startsWith(clientDir + sep) ? mapFor(candidate) : null;
  if (!map || !existsSync(map) || !existsSync(candidate)) return remoteFrame(frame, `${url.origin}${url.pathname}`);
  return { ...frame, fn: undefined, file: candidate, inApp: true };
}

function visitorKey(address: string | undefined): string {
  if (!address) return 'unknown';
  if (!address.includes(':')) return address;
  return address.toLowerCase().split(':').slice(0, 4).join(':');
}

export function radarClientErrors(options: ClientErrorsOptions = {}): RequestHandler {
  const client = options.client ?? radar;
  const clientDir = resolve(options.clientDir ?? 'build/client');
  const mapsDir = resolve(options.sourceMapsDir ?? 'build/client-maps');
  const maxBytes = options.maxBytes ?? 16_384;
  const limiter = new WindowLimiter(options.maxPerMinute ?? 10, 60_000);
  const globalLimiter = new WindowLimiter(options.maxGlobalPerMinute ?? 60, 60_000);
  const mapLocator = (file: string) => (file.startsWith(clientDir + sep) ? `${resolve(mapsDir, file.slice(clientDir.length + 1))}.map` : null);
  return async (event) => {
    try {
      if (!limiter.allow(visitorKey(clientAddress(event))) || !globalLimiter.allow('route')) return new Response(null, { status: 429 });
      if (Number(event.request.headers.get('content-length') ?? 0) > maxBytes) return new Response(null, { status: 413 });
      const text = await readLimited(event.request, maxBytes);
      if (text === null) return new Response(null, { status: 413 });
      const report = parseReport(text);
      if (!report) return new Response(null, { status: 400 });
      const mode = client.settings.redact;
      const routeOnly = client.settings.requestDetail === 'route';
      const exception: ExceptionInfo = {
        type: truncate(report.name, 200),
        message: mode === 'mask' ? maskText(report.message) : report.message,
        frames: parseBrowserStack(report.stack).map((frame) => localFrame(frame, clientDir, mapLocator, routeOnly)),
      };
      const path = mode === 'mask' ? maskText(redactUrl(report.path, mode)) : report.path;
      client.captureException(exception, {
        handled: false,
        level: 'error',
        request: routeOnly ? null : { method: 'GET', url: path },
        attrs: { source: 'browser', ...actionAttrs(report.action, mode, routeOnly) },
        runtime: null,
        enrich: { mapLocator, inferFunctionNames: true },
      });
      return new Response(null, { status: 204 });
    } catch {
      return new Response(null, { status: 204 });
    }
  };
}

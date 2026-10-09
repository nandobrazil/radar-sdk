import { resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Handle, HandleServerError, RequestEvent, RequestHandler } from '@sveltejs/kit';
import type { RadarClient } from '../client.js';
import { requestIdFrom, runWithContext, type RadarContext, type RequestLike } from '../context.js';
import { LIMITS, type ExceptionInfo, type StackFrame } from '../protocol/index.js';
import { radar } from '../radar.js';
import { maskValue } from '../redact.js';
import { redactUrl } from '../request.js';
import { truncate } from '../serialize.js';
import { parseBrowserStack } from '../stack.js';

export { moveClientSourceMaps } from './sourcemaps.js';

export type RadarHandleOptions = { client?: RadarClient };

export type ClientErrorsOptions = {
  clientDir?: string;
  sourceMapsDir?: string;
  maxPerMinute?: number;
  maxBytes?: number;
  client?: RadarClient;
};

type ClientErrorReport = { name: string; message: string; stack?: string; path: string };

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

function contextFor(event: RequestEvent): RadarContext {
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
  return { requestId: requestIdFrom(event.request.headers.get('x-request-id')), startedAt: performance.now(), req, ...(route ? { route } : {}) };
}

function withRequestId(response: Response, requestId: string): Response {
  try {
    response.headers.set('x-request-id', requestId);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set('x-request-id', requestId);
    return copy;
  }
}

export function radarHandle(options: RadarHandleOptions = {}): Handle {
  const client = options.client ?? radar;
  return async ({ event, resolve: resolveEvent }) => {
    let context: RadarContext;
    try {
      context = contextFor(event);
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

export function radarHandleError(inner?: HandleServerError, options: RadarHandleOptions = {}): HandleServerError {
  const client = options.client ?? radar;
  return (input) => {
    try {
      if ((input.status ?? 500) >= 500) client.captureError(input.error);
    } catch {
      return inner ? inner(input) : { message: 'Internal Error' };
    }
    return inner ? inner(input) : { message: 'Internal Error' };
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
  return { name: name || 'Error', message: message ?? '', ...(stack ? { stack } : {}), path: path?.startsWith('/') ? path : '/' };
}

function maskText(text: string): string {
  return text.replace(CREDENTIAL_IN_TEXT, (match) => maskValue(match));
}

function localFrame(frame: StackFrame, clientDir: string): StackFrame {
  try {
    const url = new URL(frame.file);
    if (!url.pathname.startsWith('/_app/')) return { ...frame, file: `${url.origin}${url.pathname}` };
    const candidate = resolve(clientDir, `.${decodeURIComponent(url.pathname)}`);
    return candidate.startsWith(clientDir + sep) ? { ...frame, file: candidate, inApp: true } : frame;
  } catch {
    return frame;
  }
}

export function radarClientErrors(options: ClientErrorsOptions = {}): RequestHandler {
  const client = options.client ?? radar;
  const clientDir = resolve(options.clientDir ?? 'build/client');
  const mapsDir = resolve(options.sourceMapsDir ?? 'build/client-maps');
  const maxBytes = options.maxBytes ?? 16_384;
  const limiter = new WindowLimiter(options.maxPerMinute ?? 10, 60_000);
  const mapLocator = (file: string) => (file.startsWith(clientDir + sep) ? `${resolve(mapsDir, file.slice(clientDir.length + 1))}.map` : null);
  return async (event) => {
    try {
      if (!limiter.allow(clientAddress(event) ?? 'unknown')) return new Response(null, { status: 429 });
      if (Number(event.request.headers.get('content-length') ?? 0) > maxBytes) return new Response(null, { status: 413 });
      const text = await readLimited(event.request, maxBytes);
      if (text === null) return new Response(null, { status: 413 });
      const report = parseReport(text);
      if (!report) return new Response(null, { status: 400 });
      const mode = client.settings.redact;
      const exception: ExceptionInfo = {
        type: truncate(report.name, 200),
        message: mode === 'mask' ? maskText(report.message) : report.message,
        frames: parseBrowserStack(report.stack).map((frame) => localFrame(frame, clientDir)),
      };
      const path = mode === 'mask' ? maskText(redactUrl(report.path, mode)) : report.path;
      client.captureException(exception, {
        handled: false,
        level: 'error',
        request: { method: 'GET', url: path },
        attrs: { source: 'browser' },
        runtime: null,
        enrich: { mapLocator },
      });
      return new Response(null, { status: 204 });
    } catch {
      return new Response(null, { status: 204 });
    }
  };
}

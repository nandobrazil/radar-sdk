import { currentContext } from './context.js';
import type { FetchTraceTarget, RedactMode } from './options.js';
import type { LogLevel } from './protocol/index.js';
import { looksLikeCredential, maskValue } from './redact.js';
import { describeError, elapsedSince } from './util.js';

export type FetchTraceConfig = {
  endpoint: string;
  propagateTo: FetchTraceTarget[];
  redact: RedactMode;
  record: (level: LogLevel, attrs: Record<string, unknown>) => void;
};

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const WRAPPED = Symbol.for('@oconde/radar.fetch');
const REQUEST_ID_HEADER = 'x-request-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TELEGRAM_BOT = /^bot\d{5,}:[\w-]{20,}$/;
const TOKEN_LIKE = /^[\w\-.~+=]{20,}$/;

function secretSegment(segment: string): boolean {
  if (UUID.test(segment)) return false;
  if (TELEGRAM_BOT.test(segment) || looksLikeCredential(segment)) return true;
  return TOKEN_LIKE.test(segment) && /[A-Za-z]/.test(segment) && /\d/.test(segment);
}

export function outboundPath(pathname: string, mode: RedactMode): string {
  if (mode === 'none') return pathname;
  return pathname
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        decoded = segment;
      }
      return secretSegment(decoded) ? maskValue(decoded, false) : segment;
    })
    .join('/');
}

function failureOf(error: unknown): string {
  const message = describeError(error);
  const cause = error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : '';
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}

function urlOf(input: FetchInput): URL | null {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  } catch {
    return null;
  }
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function targets(url: URL, target: FetchTraceTarget): boolean {
  if (target instanceof RegExp) return target.test(url.host);
  const wanted = target.trim().toLowerCase();
  if (wanted.startsWith('.')) return url.hostname.toLowerCase().endsWith(wanted);
  return url.host.toLowerCase() === wanted || url.hostname.toLowerCase() === wanted;
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function withRequestId(input: FetchInput, init: FetchInit, requestId: string): [FetchInput, FetchInit] {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (headers.has(REQUEST_ID_HEADER)) return [input, init];
  headers.set(REQUEST_ID_HEADER, requestId);
  if (init === undefined || isPlainObject(init)) return [input, { ...init, headers }];
  return [new Request(input, init), { headers }];
}

export function traceFetch(config: FetchTraceConfig): () => void {
  const current = globalThis.fetch as (typeof fetch & { [WRAPPED]?: typeof fetch }) | undefined;
  if (typeof current !== 'function' || current[WRAPPED]) return () => undefined;
  const original = current;
  const radarOrigin = originOf(config.endpoint);
  const traced = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = urlOf(input);
    if (!url || url.origin === radarOrigin || (url.protocol !== 'http:' && url.protocol !== 'https:')) return original(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const context = currentContext();
    const [nextInput, nextInit] = context && config.propagateTo.some((target) => targets(url, target)) ? withRequestId(input, init, context.requestId) : [input, init];
    const attrs = { method, host: url.host, path: outboundPath(url.pathname, config.redact) };
    const started = performance.now();
    try {
      const response = await original(nextInput, nextInit);
      config.record(response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : 'info', { ...attrs, status: response.status, durationMs: elapsedSince(started) });
      return response;
    } catch (error) {
      config.record('error', { ...attrs, error: failureOf(error), durationMs: elapsedSince(started) });
      throw error;
    }
  };
  Object.defineProperty(traced, WRAPPED, { value: original });
  globalThis.fetch = traced as typeof fetch;
  return () => {
    if (globalThis.fetch === (traced as typeof fetch)) globalThis.fetch = original;
  };
}

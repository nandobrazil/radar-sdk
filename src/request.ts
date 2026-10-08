import type { HeaderValue, RequestLike } from './context.js';
import type { RedactMode } from './options.js';
import { LIMITS, type RequestInfo } from './protocol/index.js';
import { isLowEntropyKey, isSensitiveHeader, isSensitiveKey, looksLikeCredential, maskValue, redactDeep } from './redact.js';
import { limitBytes, sanitize, truncate } from './serialize.js';

export function headerValue(value: HeaderValue): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : String(value);
}

export function requestHeaders(headers: Record<string, HeaderValue>, mode: RedactMode): Record<string, string> {
  const result: Record<string, string> = {};
  let count = 0;
  for (const [name, raw] of Object.entries(headers)) {
    const value = headerValue(raw);
    if (value === undefined) continue;
    if (count >= LIMITS.headers) break;
    const key = name.toLowerCase();
    result[key] = mode === 'mask' && (isSensitiveHeader(key) || looksLikeCredential(value)) ? maskValue(value) : truncate(value);
    count++;
  }
  return result;
}

export function requestPath(req: RequestLike): string {
  const url = req.originalUrl ?? req.url ?? '';
  const end = url.indexOf('?');
  return end >= 0 ? url.slice(0, end) : url;
}

export function requestRoute(req: RequestLike, route?: string): string | undefined {
  if (route) return route;
  return typeof req.route?.path === 'string' ? req.route.path : undefined;
}

export function redactPath(path: string, params: Record<string, unknown> | undefined, mode: RedactMode): string {
  if (mode === 'none' || !params) return path;
  let result = path;
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string' || value.length < 4 || !isSensitiveKey(key)) continue;
    const masked = maskValue(value, !isLowEntropyKey(key));
    for (const form of new Set([value, encodeURIComponent(value)])) result = result.split(form).join(masked);
  }
  return result;
}

export function safeUrl(req: RequestLike, mode: RedactMode): string {
  const url = req.originalUrl ?? req.url ?? '';
  const queryStart = url.indexOf('?');
  const path = queryStart >= 0 ? url.slice(0, queryStart) : url;
  const query = queryStart >= 0 ? url.slice(queryStart) : '';
  return redactUrl(redactPath(path, req.params, mode) + query, mode);
}

export function redactUrl(url: string, mode: RedactMode): string {
  const queryStart = url.indexOf('?');
  if (mode === 'none' || queryStart < 0) return url;
  const params = new URLSearchParams(url.slice(queryStart + 1));
  let changed = false;
  for (const [key, value] of [...params.entries()]) {
    if (isSensitiveKey(key) && value !== '') {
      params.set(key, maskValue(value, !isLowEntropyKey(key)));
      changed = true;
    }
  }
  return changed ? `${url.slice(0, queryStart)}?${params.toString()}` : url;
}

export function requestInfo(req: RequestLike, mode: RedactMode, extra: { route?: string; status?: number; durationMs?: number } = {}): RequestInfo {
  const route = requestRoute(req, extra.route);
  const params = prepareRecord(req.params, mode) as Record<string, string> | undefined;
  const query = prepareRecord(req.query, mode);
  const body = prepareBody(req.body, mode);
  const userAgent = headerValue(req.headers['user-agent']);
  const ip = req.ip ?? req.socket?.remoteAddress;
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    url: truncate(safeUrl(req, mode)),
    ...(route ? { route } : {}),
    ...(params ? { params } : {}),
    ...(query ? { query } : {}),
    headers: requestHeaders(req.headers, mode),
    ...(body !== undefined ? { body } : {}),
    ...(ip ? { ip } : {}),
    ...(userAgent ? { userAgent: truncate(userAgent, 500) } : {}),
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
  };
}

function isEmptyRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function prepareRecord(value: unknown, mode: RedactMode): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const clean = prepare(value, mode);
  return isEmptyRecord(clean) || typeof clean !== 'object' || clean === null ? undefined : (clean as Record<string, unknown>);
}

function prepare(value: unknown, mode: RedactMode): unknown {
  return redactDeep(sanitize(value), mode);
}

function prepareBody(body: unknown, mode: RedactMode): unknown {
  if (body === undefined || body === null || body === '') return undefined;
  const clean = prepare(body, mode);
  if (isEmptyRecord(clean)) return undefined;
  return limitBytes(clean, LIMITS.bodyBytes);
}

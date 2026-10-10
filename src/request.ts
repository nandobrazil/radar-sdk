import type { HeaderValue, RequestLike } from './context.js';
import type { RedactMode, RequestDetail } from './options.js';
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
  if (typeof req.route?.path !== 'string') return undefined;
  const base = typeof req.baseUrl === 'string' ? req.baseUrl.replace(/\/+$/, '') : '';
  if (!base) return req.route.path;
  return req.route.path === '/' ? base : `${base}${req.route.path}`;
}

const ROUTE_PARAM = /^:([A-Za-z_$][\w$]*)/;

function pathSegments(value: string): string[] {
  const segments = value.split('/');
  while (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();
  return segments;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function routeParams(req: RequestLike, path: string): Record<string, string> {
  if (typeof req.route?.path !== 'string') return {};
  const pattern = pathSegments(`${typeof req.baseUrl === 'string' ? req.baseUrl : ''}${req.route.path}`).filter((segment, index) => index > 0 || segment !== '');
  const values = pathSegments(path);
  if (pattern.length > values.length) return {};
  const offset = values.length - pattern.length;
  const result: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index++) {
    const value = values[offset + index];
    const param = ROUTE_PARAM.exec(pattern[index]);
    if (!param) {
      if (pattern[index] !== value) return {};
      continue;
    }
    if (value) result[param[1]] = decodeSegment(value);
  }
  return result;
}

export function pathParams(req: RequestLike, path: string): Record<string, unknown> {
  return { ...routeParams(req, path), ...(req.params ?? {}) };
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
  return redactUrl(redactPath(path, pathParams(req, path), mode) + query, mode);
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

export function requestInfo(req: RequestLike, mode: RedactMode, extra: { route?: string; status?: number; durationMs?: number } = {}, detail: RequestDetail = 'full'): RequestInfo {
  const route = requestRoute(req, extra.route);
  if (detail === 'route') {
    return {
      method: (req.method ?? 'GET').toUpperCase(),
      url: route ?? '',
      ...(route ? { route } : {}),
      ...(extra.status !== undefined ? { status: extra.status } : {}),
      ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    };
  }
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

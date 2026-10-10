import type { LogLevel } from './protocol/index.js';

export type RedactMode = 'mask' | 'none';
export type RequestDetail = 'full' | 'route';
export type FetchTraceTarget = string | RegExp;
export type TraceFetchOption = boolean | { propagateTo?: FetchTraceTarget[] };
export type ResolvedTraceFetch = { enabled: boolean; propagateTo: FetchTraceTarget[] };

export type RadarOptions = {
  key?: string;
  endpoint?: string;
  environment?: string;
  release?: string;
  enabled?: boolean;
  console?: boolean;
  minLevel?: LogLevel;
  redact?: RedactMode;
  requestDetail?: RequestDetail;
  logRequests?: boolean;
  ignorePaths?: string[];
  captureUnhandled?: boolean;
  traceFetch?: TraceFetchOption;
  debug?: boolean;
};

export type ResolvedOptions = {
  key: string | undefined;
  endpoint: string;
  environment: string;
  release: string | undefined;
  enabled: boolean;
  console: boolean;
  minLevel: LogLevel;
  redact: RedactMode;
  requestDetail: RequestDetail;
  logRequests: boolean;
  ignorePaths: string[];
  captureUnhandled: boolean;
  traceFetch: ResolvedTraceFetch;
  debug: boolean;
};

export const DEFAULT_ENDPOINT = 'https://radar-ingest.oconde.dev';

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function resolveTraceFetch(value: TraceFetchOption | undefined): ResolvedTraceFetch {
  if (!value) return { enabled: false, propagateTo: [] };
  if (value === true) return { enabled: true, propagateTo: [] };
  const targets = Array.isArray(value.propagateTo) ? value.propagateTo : [];
  return { enabled: true, propagateTo: targets.filter((target) => (typeof target === 'string' ? target.trim() !== '' : target instanceof RegExp)) };
}

export function resolveOptions(options: RadarOptions = {}, env: NodeJS.ProcessEnv = process.env): ResolvedOptions {
  const key = options.key?.trim() || undefined;
  return {
    key,
    endpoint: (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    environment: options.environment ?? env.NODE_ENV ?? 'production',
    release: options.release || undefined,
    enabled: options.enabled ?? Boolean(key),
    console: options.console ?? false,
    minLevel: options.minLevel && LEVELS.includes(options.minLevel) ? options.minLevel : 'info',
    redact: options.redact === 'none' ? 'none' : 'mask',
    requestDetail: options.requestDetail === 'route' ? 'route' : 'full',
    logRequests: options.logRequests ?? true,
    ignorePaths: options.ignorePaths ?? ['/healthz', '/health'],
    captureUnhandled: options.captureUnhandled ?? true,
    traceFetch: resolveTraceFetch(options.traceFetch),
    debug: options.debug ?? false,
  };
}

export function levelEnabled(level: LogLevel, minLevel: LogLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(minLevel);
}

import type { LogLevel } from './protocol/index.js';

export type RedactMode = 'mask' | 'none';
export type RequestDetail = 'full' | 'route';
export type FetchTraceTarget = string | RegExp;
export type TraceFetchOption = boolean | { propagateTo?: FetchTraceTarget[]; ignore?: FetchTraceTarget[] };
export type ResolvedTraceFetch = { enabled: boolean; propagateTo: FetchTraceTarget[]; ignore: FetchTraceTarget[] };
export type RequestPattern = string | RegExp;
export type LogRequestsOption = boolean | { include?: RequestPattern[]; exclude?: RequestPattern[]; sample?: number };
export type ResolvedLogRequests = { enabled: boolean; include: RequestPattern[]; exclude: RequestPattern[]; sample: number };

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
  logRequests?: LogRequestsOption;
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
  logRequests: ResolvedLogRequests;
  ignorePaths: string[];
  captureUnhandled: boolean;
  traceFetch: ResolvedTraceFetch;
  debug: boolean;
};

export const DEFAULT_ENDPOINT = 'https://radar-ingest.oconde.dev';

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function patterns(value: unknown): (string | RegExp)[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): (string | RegExp)[] => {
    if (item instanceof RegExp) return [item];
    if (typeof item === 'string' && item.trim() !== '') return [item.trim()];
    return [];
  });
}

function resolveTraceFetch(value: TraceFetchOption | undefined): ResolvedTraceFetch {
  if (!value) return { enabled: false, propagateTo: [], ignore: [] };
  if (value === true) return { enabled: true, propagateTo: [], ignore: [] };
  return { enabled: true, propagateTo: patterns(value.propagateTo), ignore: patterns(value.ignore) };
}

function resolveLogRequests(value: LogRequestsOption | undefined): ResolvedLogRequests {
  if (value === false) return { enabled: false, include: [], exclude: [], sample: 1 };
  if (value === undefined || value === true || typeof value !== 'object' || value === null) return { enabled: true, include: [], exclude: [], sample: 1 };
  const sample = typeof value.sample === 'number' && Number.isFinite(value.sample) && value.sample > 0 && value.sample <= 1 ? value.sample : 1;
  return { enabled: true, include: patterns(value.include), exclude: patterns(value.exclude), sample };
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
    logRequests: resolveLogRequests(options.logRequests),
    ignorePaths: options.ignorePaths ?? ['/healthz', '/health'],
    captureUnhandled: options.captureUnhandled ?? true,
    traceFetch: resolveTraceFetch(options.traceFetch),
    debug: options.debug ?? false,
  };
}

export function levelEnabled(level: LogLevel, minLevel: LogLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(minLevel);
}

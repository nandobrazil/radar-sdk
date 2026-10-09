import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { LIMITS, type UserInfo } from './protocol/index.js';

export type HeaderValue = string | string[] | number | undefined;

export type RequestLike = {
  method?: string;
  url?: string;
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: unknown };
  params?: Record<string, unknown>;
  query?: unknown;
  headers: Record<string, HeaderValue>;
  body?: unknown;
  ip?: string;
  socket?: { remoteAddress?: string };
};

export type ResponseLike = {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  once(event: 'finish', listener: () => void): unknown;
};

export type RadarContext = {
  requestId: string;
  startedAt: number;
  req?: RequestLike;
  route?: string;
  user?: UserInfo;
};

type GlobalState = { storage: AsyncLocalStorage<RadarContext>; client?: unknown };

const STATE_KEY = Symbol.for('@oconde/radar');

export function globalState(): GlobalState {
  const holder = globalThis as unknown as Record<symbol, GlobalState | undefined>;
  let state = holder[STATE_KEY];
  if (!state) {
    state = { storage: new AsyncLocalStorage<RadarContext>() };
    holder[STATE_KEY] = state;
  }
  return state;
}

export function currentContext(): RadarContext | undefined {
  return globalState().storage.getStore();
}

export function runWithContext<T>(context: RadarContext, fn: () => T): T {
  return globalState().storage.run(context, fn);
}

const SAFE_REQUEST_ID = /^[\x21-\x7e]+$/;

export function requestIdFrom(incoming: string | undefined | null): string {
  const value = incoming?.trim();
  return value && value.length <= LIMITS.requestIdLength && SAFE_REQUEST_ID.test(value) ? value : randomUUID();
}

export type ReportOptions = { endpoint?: string };

export type ClientErrorPayload = { name: string; message: string; stack?: string; path: string };

export const DEFAULT_CLIENT_ERRORS_ENDPOINT = '/api/radar/client-errors';

type Listener = (event: unknown) => void;

type BrowserGlobals = {
  window?: { addEventListener(type: string, listener: Listener): void; removeEventListener(type: string, listener: Listener): void };
  location?: { pathname: string; search: string };
  navigator?: { sendBeacon?: (url: string, data: Blob) => boolean };
  fetch?: (input: string, init: RequestInit) => Promise<unknown>;
};

type ErrorHandlerInput = { error: unknown; status?: number; message: string };

const MAX_REPORTS = 10;
const MAX_MESSAGE = 2000;
const MAX_STACK = 12_000;

const sent = { count: 0, keys: new Set<string>() };

function browser(): BrowserGlobals {
  return globalThis as unknown as BrowserGlobals;
}

function describe(error: unknown, path: string): ClientErrorPayload {
  if (error instanceof Error) {
    return { name: error.name || 'Error', message: String(error.message ?? '').slice(0, MAX_MESSAGE), ...(error.stack ? { stack: error.stack.slice(0, MAX_STACK) } : {}), path };
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const name = typeof record.name === 'string' && record.name ? record.name : 'Error';
    const message = typeof record.message === 'string' ? record.message : safeString(error);
    return { name, message: message.slice(0, MAX_MESSAGE), ...(typeof record.stack === 'string' ? { stack: record.stack.slice(0, MAX_STACK) } : {}), path };
  }
  return { name: 'Error', message: String(error).slice(0, MAX_MESSAGE), path };
}

function safeString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function send(endpoint: string, body: string): void {
  const globals = browser();
  if (typeof globals.fetch === 'function') {
    globals.fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true, credentials: 'same-origin' }).catch(() => undefined);
    return;
  }
  if (typeof globals.navigator?.sendBeacon === 'function') globals.navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
}

export function reportClientError(error: unknown, options: ReportOptions = {}): void {
  try {
    const globals = browser();
    if (!globals.window || !globals.location) return;
    if (sent.count >= MAX_REPORTS) return;
    const payload = describe(error, `${globals.location.pathname}${globals.location.search}`);
    const key = `${payload.name}|${payload.message}|${(payload.stack ?? '').slice(0, 300)}`;
    if (sent.keys.has(key)) return;
    sent.keys.add(key);
    sent.count += 1;
    send(options.endpoint ?? DEFAULT_CLIENT_ERRORS_ENDPOINT, JSON.stringify(payload));
  } catch {
    return;
  }
}

export function handleErrorWithRadar<Input extends ErrorHandlerInput, Output>(handler?: (input: Input) => Output, options: ReportOptions = {}): (input: Input) => Output | { message: string } {
  return (input) => {
    if ((input.status ?? 500) >= 500) reportClientError(input.error, options);
    return handler ? handler(input) : { message: 'Internal Error' };
  };
}

export function listenForClientErrors(options: ReportOptions = {}): () => void {
  const target = browser().window;
  if (!target) return () => undefined;
  const onError: Listener = (event) => {
    const record = (event ?? {}) as { error?: unknown; message?: unknown };
    reportClientError(record.error ?? record.message, options);
  };
  const onRejection: Listener = (event) => reportClientError(((event ?? {}) as { reason?: unknown }).reason, options);
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

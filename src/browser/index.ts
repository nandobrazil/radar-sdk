export type ReportOptions = { endpoint?: string };
export type ListenOptions = ReportOptions & { captureActions?: boolean };

export type UiAction = { kind: 'click' | 'submit'; element: string; label: string; msBefore: number };
export type ClientErrorPayload = { name: string; message: string; stack?: string; path: string; action?: UiAction };

export const DEFAULT_CLIENT_ERRORS_ENDPOINT = '/api/radar/client-errors';

type Listener = (event: unknown) => void;

type ElementLike = { tagName?: string; textContent?: string | null; closest?(selector: string): ElementLike | null; getAttribute?(name: string): string | null };

type BrowserGlobals = {
  window?: { addEventListener(type: string, listener: Listener, capture?: boolean): void; removeEventListener(type: string, listener: Listener, capture?: boolean): void };
  location?: { pathname: string; search: string };
  navigator?: { sendBeacon?: (url: string, data: Blob) => boolean };
  fetch?: (input: string, init: RequestInit) => Promise<unknown>;
};

type ErrorHandlerInput = { error: unknown; status?: number; message: string };

const MAX_REPORTS = 10;
const MAX_MESSAGE = 2000;
const MAX_STACK = 12_000;
const ACTION_WINDOW_MS = 10_000;
const MAX_LABEL = 60;
const INTERACTIVE = 'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], input, select, textarea, summary, label';
const BUTTON_INPUTS = new Set(['button', 'submit', 'reset', 'image']);
const FIELDS = new Set(['input', 'select', 'textarea']);
const ELEMENT_NAMES: Record<string, string> = { a: 'link', button: 'button', input: 'input', select: 'select', textarea: 'textarea', summary: 'summary', label: 'label', form: 'form' };

const sent = { count: 0, keys: new Set<string>() };
let lastAction: { kind: UiAction['kind']; element: string; label: string; at: number } | null = null;

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

function attribute(node: ElementLike, name: string): string | null {
  try {
    const value = node.getAttribute?.(name);
    return typeof value === 'string' && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function cleanLabel(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
}

function describeElement(target: unknown, kind: UiAction['kind']): { element: string; label: string } | null {
  const node = target as ElementLike | null;
  if (!node || typeof node !== 'object' || typeof node.tagName !== 'string') return null;
  const found = kind === 'click' && typeof node.closest === 'function' ? node.closest(INTERACTIVE) : node;
  const element = found ?? node;
  const tag = (element.tagName ?? '').toLowerCase();
  const type = (attribute(element, 'type') ?? '').toLowerCase();
  const role = attribute(element, 'role');
  const name = role ?? (tag === 'input' && BUTTON_INPUTS.has(type) ? 'button' : (ELEMENT_NAMES[tag] ?? (/^[a-z][a-z0-9-]*$/.test(tag) ? tag : 'element')));
  const named = attribute(element, 'aria-label') ?? attribute(element, 'title');
  const fieldLabel = FIELDS.has(tag) && !BUTTON_INPUTS.has(type) ? (attribute(element, 'name') ?? attribute(element, 'placeholder') ?? attribute(element, 'id')) : null;
  const buttonValue = tag === 'input' && BUTTON_INPUTS.has(type) ? attribute(element, 'value') : null;
  const text = FIELDS.has(tag) || tag === 'form' ? null : element.textContent;
  const formLabel = tag === 'form' ? (attribute(element, 'name') ?? attribute(element, 'id')) : null;
  const label = cleanLabel(named ?? fieldLabel ?? buttonValue ?? formLabel ?? (cleanLabel(text) || attribute(element, 'id')));
  return { element: name.slice(0, 24), label };
}

function recordAction(kind: UiAction['kind']): Listener {
  return (event) => {
    try {
      const described = describeElement((event as { target?: unknown } | null)?.target, kind);
      if (described) lastAction = { kind, ...described, at: Date.now() };
    } catch {
      return;
    }
  };
}

function recentAction(): UiAction | undefined {
  if (!lastAction) return undefined;
  const msBefore = Date.now() - lastAction.at;
  if (msBefore < 0 || msBefore > ACTION_WINDOW_MS) return undefined;
  return { kind: lastAction.kind, element: lastAction.element, label: lastAction.label, msBefore };
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
    const action = recentAction();
    const payload = { ...describe(error, `${globals.location.pathname}${globals.location.search}`), ...(action ? { action } : {}) };
    const key = `${payload.name}|${payload.message}|${(payload.stack ?? '').slice(0, 300)}`;
    if (sent.keys.has(key)) return;
    sent.keys.add(key);
    sent.count += 1;
    send(options.endpoint ?? DEFAULT_CLIENT_ERRORS_ENDPOINT, JSON.stringify(payload));
  } catch {
    return;
  }
}

export function handleErrorWithRadar<Input extends ErrorHandlerInput, Output>(handler?: (input: Input) => Output, options: ReportOptions = {}): (input: Input) => Output | undefined {
  return (input) => {
    const unexpected = (input.status ?? 500) >= 500;
    if (unexpected) reportClientError(input.error, options);
    if (handler) return handler(input);
    if (unexpected) console.error(input.error);
    return undefined;
  };
}

export function listenForClientErrors(options: ListenOptions = {}): () => void {
  const target = browser().window;
  if (!target) return () => undefined;
  const onClick = recordAction('click');
  const onSubmit = recordAction('submit');
  const captureActions = options.captureActions !== false;
  const onError: Listener = (event) => {
    const record = (event ?? {}) as { error?: unknown; message?: unknown };
    reportClientError(record.error ?? record.message, options);
  };
  const onRejection: Listener = (event) => reportClientError(((event ?? {}) as { reason?: unknown }).reason, options);
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  if (captureActions) {
    target.addEventListener('click', onClick, true);
    target.addEventListener('submit', onSubmit, true);
  }
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
    if (captureActions) {
      target.removeEventListener('click', onClick, true);
      target.removeEventListener('submit', onSubmit, true);
    }
  };
}

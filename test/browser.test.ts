import type { HandleClientError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type BrowserModule = typeof import('../src/browser/index.js');

type Listener = (event: unknown) => void;

const listeners = new Map<string, Set<Listener>>();
let fetchMock: ReturnType<typeof vi.fn>;

async function load(): Promise<BrowserModule> {
  vi.resetModules();
  return import('../src/browser/index.js');
}

function sentBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

beforeEach(() => {
  listeners.clear();
  fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  vi.stubGlobal('location', { pathname: '/checkout', search: '?step=2' });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => listeners.get(type)?.delete(listener),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reportClientError', () => {
  it('posts name, message, stack and path to the app endpoint with keepalive', async () => {
    const { reportClientError } = await load();
    const error = new TypeError('cart is null');
    reportClientError(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(endpoint).toBe('/api/radar/client-errors');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' } });
    expect(sentBodies()[0]).toEqual({ name: 'TypeError', message: 'cart is null', stack: error.stack, path: '/checkout?step=2' });
  });

  it('skips repeats and stops after ten reports per page', async () => {
    const { reportClientError } = await load();
    const same = new Error('same');
    reportClientError(same);
    reportClientError(same);
    for (let index = 0; index < 20; index++) reportClientError(new Error(`error ${index}`));
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('handles non-error values and a custom endpoint', async () => {
    const { reportClientError } = await load();
    reportClientError('plain text', { endpoint: '/radar/errors' });
    reportClientError({ name: 'ApiError', message: 'quota' });
    expect(fetchMock.mock.calls.map(([endpoint]) => endpoint)).toEqual(['/radar/errors', '/api/radar/client-errors']);
    expect(sentBodies()).toEqual([
      { name: 'Error', message: 'plain text', path: '/checkout?step=2' },
      { name: 'ApiError', message: 'quota', path: '/checkout?step=2' },
    ]);
  });

  it('falls back to sendBeacon and does nothing on the server', async () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal('fetch', undefined);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const { reportClientError } = await load();
    reportClientError(new Error('offline'));
    expect(beacon).toHaveBeenCalledWith('/api/radar/client-errors', expect.any(Blob));
    vi.stubGlobal('window', undefined);
    const server = await load();
    expect(() => server.reportClientError(new Error('ssr'))).not.toThrow();
    expect(beacon).toHaveBeenCalledTimes(1);
  });
});

describe('handleErrorWithRadar', () => {
  it('reports only unexpected errors and delegates to the handler', async () => {
    const { handleErrorWithRadar } = await load();
    const handle = handleErrorWithRadar(({ message }) => ({ message: `oops: ${message}` }));
    expect(handle({ error: new Error('crash'), status: 500, message: 'Internal Error' })).toEqual({ message: 'oops: Internal Error' });
    expect(handle({ error: new Error('missing'), status: 404, message: 'Not Found' })).toEqual({ message: 'oops: Not Found' });
    expect(sentBodies().map((body) => body.message)).toEqual(['crash']);
  });
});

describe('handleErrorWithRadar types', () => {
  it('fits the SvelteKit client hook with and without a handler', async () => {
    const { handleErrorWithRadar } = await load();
    const plain: HandleClientError = handleErrorWithRadar();
    const custom: HandleClientError = handleErrorWithRadar(({ status }) => ({ message: status === 404 ? 'Página não encontrada' : 'Algo deu errado' }));
    expect([typeof plain, typeof custom]).toEqual(['function', 'function']);
  });
});

describe('listenForClientErrors', () => {
  it('reports window errors and unhandled rejections until stopped', async () => {
    const { listenForClientErrors } = await load();
    const stop = listenForClientErrors();
    for (const listener of listeners.get('error') ?? []) listener({ error: new Error('click handler'), message: 'Uncaught Error: click handler' });
    for (const listener of listeners.get('unhandledrejection') ?? []) listener({ reason: new Error('fetch failed') });
    stop();
    expect(listeners.get('error')?.size).toBe(0);
    expect(sentBodies().map((body) => body.message)).toEqual(['click handler', 'fetch failed']);
  });
});

describe('handleErrorWithRadar without a handler', () => {
  it('prints the error and lets SvelteKit keep its own message', async () => {
    const { handleErrorWithRadar } = await load();
    const printed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = handleErrorWithRadar();
    expect(handle({ error: new Error('boom'), status: 500, message: 'Internal Error' } as never)).toBeUndefined();
    expect(handle({ error: new Error('nope'), status: 404, message: 'Not Found' } as never)).toBeUndefined();
    expect(printed).toHaveBeenCalledTimes(1);
    printed.mockRestore();
  });
});


type FakeElement = { tagName: string; attributes: Record<string, string>; textContent?: string; closest(selector: string): FakeElement | null; getAttribute(name: string): string | null };

function element(tagName: string, attributes: Record<string, string> = {}, textContent = '', interactive = true): FakeElement {
  const node: FakeElement = {
    tagName: tagName.toUpperCase(),
    attributes,
    textContent,
    closest: () => (interactive ? node : null),
    getAttribute: (name) => attributes[name] ?? null,
  };
  return node;
}

function fire(type: string, event: unknown): void {
  for (const listener of listeners.get(type) ?? []) listener(event);
}

describe('listenForClientErrors with the last action', () => {
  it('attaches the click that came right before the error', async () => {
    const { listenForClientErrors } = await load();
    listenForClientErrors();
    fire('click', { target: element('button', {}, '  Aplicar\n   cupom  ') });
    fire('error', { error: new Error('price of undefined') });
    const [body] = sentBodies();
    expect(body!.action).toMatchObject({ kind: 'click', element: 'button', label: 'Aplicar cupom' });
    expect((body!.action as { msBefore: number }).msBefore).toBeGreaterThanOrEqual(0);
  });

  it('describes links, form submissions and fields without reading what was typed', async () => {
    const { listenForClientErrors } = await load();
    listenForClientErrors();
    fire('click', { target: element('a', { 'aria-label': 'Abrir pedido A1002' }, 'ícone') });
    fire('error', { error: new Error('one') });
    fire('submit', { target: element('form', { name: 'checkout' }) });
    fire('error', { error: new Error('two') });
    fire('click', { target: element('input', { type: 'password', name: 'senha', value: 'segredo123' }) });
    fire('error', { error: new Error('three') });
    const actions = sentBodies().map((body) => body.action as Record<string, unknown>);
    expect(actions[0]).toMatchObject({ kind: 'click', element: 'link', label: 'Abrir pedido A1002' });
    expect(actions[1]).toMatchObject({ kind: 'submit', element: 'form', label: 'checkout' });
    expect(actions[2]).toMatchObject({ kind: 'click', element: 'input', label: 'senha' });
    expect(JSON.stringify(sentBodies())).not.toContain('segredo123');
  });

  it('never reads the text of a container that is not a control', async () => {
    const { listenForClientErrors } = await load();
    listenForClientErrors();
    const container = element('div', { id: 'pedido-resumo' }, 'Marina Souza, CPF 123.456.789-09, Rua das Flores 10', false);
    fire('click', { target: container });
    fire('error', { error: new Error('summary') });
    expect(sentBodies()[0]!.action).toMatchObject({ kind: 'click', element: 'div', label: 'pedido-resumo' });
    expect(JSON.stringify(sentBodies())).not.toContain('Marina');
  });

  it('leaves out actions older than ten seconds and can be turned off', async () => {
    vi.useFakeTimers();
    try {
      const { listenForClientErrors } = await load();
      const stop = listenForClientErrors();
      fire('click', { target: element('button', {}, 'Salvar') });
      vi.advanceTimersByTime(10_001);
      fire('error', { error: new Error('late') });
      stop();
      listeners.clear();
      listenForClientErrors({ captureActions: false });
      expect(listeners.has('click')).toBe(false);
      expect(sentBodies()[0]!.action).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

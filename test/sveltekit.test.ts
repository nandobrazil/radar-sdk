import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Handle, HandleServerError, RequestEvent, RequestHandler } from '@sveltejs/kit';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RadarClient } from '../src/client.js';
import type { ErrorEvent, LogEvent } from '../src/protocol/index.js';
import { moveClientSourceMaps, radarClientErrors, radarHandle, radarHandleError, routeName } from '../src/sveltekit/index.js';
import { startFakeIngest, type FakeIngest } from './helpers/fake-ingest.js';

let server: FakeIngest;
let client: RadarClient;

beforeEach(async () => {
  server = await startFakeIngest();
  client = new RadarClient();
  client.init({ key: 'rk_test', endpoint: server.url, environment: 'test', captureUnhandled: false });
});

afterEach(async () => {
  await client.close();
  await server.close();
});

const logs = () => server.events().filter((event): event is LogEvent => event.type === 'log');
const errors = () => server.events().filter((event): event is ErrorEvent => event.type === 'error');

type EventInput = { url: string; method?: string; headers?: Record<string, string>; body?: string; routeId?: string | null; params?: Record<string, string>; address?: string };

function requestEvent(input: EventInput): RequestEvent {
  const url = new URL(input.url);
  const request = new Request(url, { method: input.method ?? 'GET', headers: input.headers, ...(input.body !== undefined ? { body: input.body } : {}) });
  return {
    request,
    url,
    params: input.params ?? {},
    route: { id: input.routeId ?? null },
    getClientAddress: () => {
      if (!input.address) throw new Error('no address');
      return input.address;
    },
  } as unknown as RequestEvent;
}

describe('type compatibility', () => {
  it('returns SvelteKit hook and handler types', () => {
    const handle: Handle = radarHandle();
    const handleError: HandleServerError = radarHandleError();
    const post: RequestHandler = radarClientErrors();
    expect([typeof handle, typeof handleError, typeof post]).toEqual(['function', 'function', 'function']);
  });
});

describe('routeName', () => {
  it('drops route groups and keeps parameters', () => {
    expect(routeName('/(app)/projects/[slug]/(tabs)/settings')).toBe('/projects/[slug]/settings');
    expect(routeName('/(public)')).toBe('/');
    expect(routeName(null)).toBeUndefined();
  });
});

describe('radarHandle', () => {
  it('runs the request in a context, tags the response and logs http.request with masked path params', async () => {
    const handle = radarHandle({ client });
    const event = requestEvent({
      url: 'https://shop.test/stores/42/reset/s3cr3t-reset-token?page=2',
      headers: { 'x-request-id': 'req-77', cookie: 'session=abcdefghijklmnop' },
      routeId: '/(app)/stores/[storeId]/reset/[token]',
      params: { storeId: '42', token: 's3cr3t-reset-token' },
      address: '203.0.113.9',
    });
    const response = await handle({
      event,
      resolve: async () => {
        client.info('inside.handler');
        return new Response('ok', { status: 201 });
      },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('req-77');
    await client.flush();
    const inside = logs().find((item) => item.message === 'inside.handler');
    expect(inside!.requestId).toBe('req-77');
    const http = logs().find((item) => item.message === 'http.request');
    expect(http!.level).toBe('info');
    expect(http!.attrs).toMatchObject({ method: 'GET', route: '/stores/[storeId]/reset/[token]', status: 201 });
    expect(JSON.stringify(server.events())).not.toContain('s3cr3t-reset-token');
  });

  it('skips ignored paths, still tags immutable redirects and logs 500 when resolve throws', async () => {
    const handle = radarHandle({ client });
    await handle({ event: requestEvent({ url: 'https://shop.test/healthz' }), resolve: async () => new Response('ok') });
    const redirect = await handle({ event: requestEvent({ url: 'https://shop.test/old' }), resolve: async () => Response.redirect('https://shop.test/new', 303) });
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      handle({
        event: requestEvent({ url: 'https://shop.test/boom' }),
        resolve: async () => {
          throw new Error('resolve exploded');
        },
      }),
    ).rejects.toThrow('resolve exploded');
    await client.flush();
    const paths = logs()
      .filter((item) => item.message === 'http.request')
      .map((item) => [item.attrs!.path, item.attrs!.status]);
    expect(paths).toEqual([
      ['/old', 303],
      ['/boom', 500],
    ]);
  });

  it('sends errors captured by radarHandleError with the request of the context', async () => {
    const handle = radarHandle({ client });
    const handleError = radarHandleError(({ message }) => ({ message: `custom ${message}` }), { client });
    const event = requestEvent({ url: 'https://shop.test/checkout', method: 'POST', routeId: '/checkout' });
    let returned: unknown;
    await handle({
      event,
      resolve: async () => {
        returned = await handleError({ error: new Error('db down'), event, status: 500, message: 'Internal Error' });
        await handleError({ error: new Error('not found'), event, status: 404, message: 'Not Found' });
        return new Response('fail', { status: 500 });
      },
    });
    expect(returned).toEqual({ message: 'custom Internal Error' });
    await client.flush();
    expect(errors().map((item) => item.exception.message)).toEqual(['db down']);
    expect(errors()[0]!.request).toMatchObject({ method: 'POST', url: '/checkout', route: '/checkout' });
    expect(await radarHandleError(undefined, { client })({ error: new Error('x'), event, status: 500, message: 'Internal Error' })).toEqual({ message: 'Internal Error' });
  });
});

describe('radarClientErrors', () => {
  const PAGE_SOURCE = ['type Cart = { items: string[] };', '', 'export function checkout(cart: Cart): number {', '  const first = cart.items[0];', '  throw new Error(`empty cart ${first}`);', '}', ''].join('\n');
  let root: string;
  let clientDir: string;
  let mapsDir: string;
  let stack: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'radar-sveltekit-')));
    clientDir = join(root, 'build/client');
    mapsDir = join(root, 'build/client-maps');
    mkdirSync(join(clientDir, '_app/immutable/nodes'), { recursive: true });
    mkdirSync(join(mapsDir, '_app/immutable/nodes'), { recursive: true });
    mkdirSync(join(root, 'src/routes'), { recursive: true });
    const output = ts.transpileModule(PAGE_SOURCE, { fileName: '+page.ts', compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, sourceMap: true, inlineSources: true } });
    const map = JSON.parse(output.sourceMapText ?? '{}') as { sources: string[] };
    map.sources = ['../../../../../src/routes/+page.ts'];
    const code = output.outputText.replace(/\/\/# sourceMappingURL=.*$/m, '').trimEnd();
    writeFileSync(join(clientDir, '_app/immutable/nodes/2.js'), `${code}\n`);
    writeFileSync(join(mapsDir, '_app/immutable/nodes/2.js.map'), JSON.stringify(map));
    const lines = code.split('\n');
    const lineIndex = lines.findIndex((line) => line.includes('throw new Error'));
    const column = (lines[lineIndex] ?? '').indexOf('throw') + 1;
    stack = `Error: empty cart undefined\n    at checkout (https://shop.test/_app/immutable/nodes/2.js:${lineIndex + 1}:${column})\n    at https://cdn.other.test/lib.js:1:1`;
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function post(handler: RequestHandler, body: string, address = '198.51.100.7'): Promise<Response> {
    return Promise.resolve(handler(requestEvent({ url: 'https://shop.test/api/radar/client-errors', method: 'POST', headers: { 'content-type': 'application/json' }, body, address }) as Parameters<RequestHandler>[0]));
  }

  it('records a browser error with the original source from the hidden map and no IP or user agent', async () => {
    const handler = radarClientErrors({ clientDir, sourceMapsDir: mapsDir, client });
    const body = JSON.stringify({ name: 'Error', message: 'empty cart for Bearer abcdefghijklmnopqrstuvwxyz', stack, path: '/cart?token=abcdefghijklmnop&step=2' });
    const response = await post(handler, body);
    expect(response.status).toBe(204);
    await client.flush();
    const [event] = errors();
    expect(event).toMatchObject({ handled: false, level: 'error', attrs: { source: 'browser' } });
    expect(event!.runtime).toBeUndefined();
    expect(event!.request!.method).toBe('GET');
    expect(event!.request!.url).toMatch(/^\/cart\?token=abcd%E2%80%A6mnop\+%23[0-9a-f]{8}&step=2$/);
    expect(event!.exception.message).not.toContain('abcdefghijklmnopqrstuvwxyz');
    const [top, external] = event!.exception.frames;
    expect(top!.file.endsWith('src/routes/+page.ts')).toBe(true);
    expect(top!.line).toBe(5);
    expect(top!.inApp).toBe(true);
    expect(top!.context?.line).toContain('throw new Error');
    expect(external).toMatchObject({ file: 'https://cdn.other.test/lib.js', inApp: false });
    const raw = JSON.stringify(event);
    expect(raw).not.toContain('198.51.100.7');
    expect(raw).not.toContain('"ip"');
    expect(raw).not.toContain('userAgent');
  });

  it('refuses oversized, malformed and too frequent reports', async () => {
    const handler = radarClientErrors({ clientDir, sourceMapsDir: mapsDir, maxPerMinute: 3, maxBytes: 256, client });
    expect((await post(handler, JSON.stringify({ message: 'x'.repeat(400), path: '/' }), '192.0.2.1')).status).toBe(413);
    expect((await post(handler, 'not json', '192.0.2.1')).status).toBe(400);
    expect((await post(handler, JSON.stringify({ path: '/' }), '192.0.2.1')).status).toBe(400);
    expect((await post(handler, JSON.stringify({ message: 'late', path: '/' }), '192.0.2.1')).status).toBe(429);
    expect((await post(handler, JSON.stringify({ message: 'other visitor', path: '/' }), '192.0.2.2')).status).toBe(204);
  });

  it('never reads a local file outside the client directory', async () => {
    const handler = radarClientErrors({ clientDir, sourceMapsDir: mapsDir, client });
    const escape = ['Error: x', '    at f (https://shop.test/_app/../../../etc/passwd:1:1)', '    at g (https://shop.test/_app/..%2F..%2F..%2F..%2Fetc%2Fpasswd:1:1)'].join('\n');
    expect((await post(handler, JSON.stringify({ message: 'x', stack: escape, path: '/' }))).status).toBe(204);
    await client.flush();
    for (const frame of errors()[0]!.exception.frames) {
      expect(frame.file.startsWith('https://shop.test/')).toBe(true);
      expect(frame.inApp).toBe(false);
      expect(frame.context).toBeUndefined();
    }
  });
});

describe('moveClientSourceMaps', () => {
  it('moves client maps out of the served directory and drops their compressed copies', () => {
    const build = realpathSync(mkdtempSync(join(tmpdir(), 'radar-maps-')));
    mkdirSync(join(build, 'client/_app/immutable/chunks'), { recursive: true });
    writeFileSync(join(build, 'client/_app/immutable/chunks/a.js'), 'x');
    writeFileSync(join(build, 'client/_app/immutable/chunks/a.js.map'), '{}');
    writeFileSync(join(build, 'client/_app/immutable/chunks/a.js.map.gz'), 'gz');
    writeFileSync(join(build, 'client/app.css.map'), '{}');
    expect(moveClientSourceMaps(build)).toBe(2);
    expect(readdirSync(join(build, 'client/_app/immutable/chunks'))).toEqual(['a.js']);
    expect(readdirSync(join(build, 'client-maps/_app/immutable/chunks'))).toEqual(['a.js.map']);
    expect(readdirSync(join(build, 'client-maps'))).toContain('app.css.map');
    expect(moveClientSourceMaps(join(build, 'missing'))).toBe(0);
    rmSync(build, { recursive: true, force: true });
  });
});

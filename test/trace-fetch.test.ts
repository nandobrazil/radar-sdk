import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RadarClient } from '../src/client.js';
import { runWithContext } from '../src/context.js';
import type { LogEvent } from '../src/protocol/index.js';
import { startFakeIngest, type FakeIngest } from './helpers/fake-ingest.js';

type Upstream = { url: string; host: string; received: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[]; close(): Promise<void> };

async function startUpstream(): Promise<Upstream> {
  const received: Upstream['received'] = [];
  const server: Server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
    res.writeHead(req.url === '/down' ? 503 : 200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const originalFetch = globalThis.fetch;
let ingest: FakeIngest;
let api: Upstream;
let other: Upstream;
let client: RadarClient;

beforeEach(async () => {
  ingest = await startFakeIngest();
  api = await startUpstream();
  other = await startUpstream();
  client = new RadarClient();
  client.init({ key: 'rk_test', endpoint: ingest.url, environment: 'test', captureUnhandled: false, traceFetch: { propagateTo: [api.host] } });
});

afterEach(async () => {
  await client.close();
  await Promise.all([ingest.close(), api.close(), other.close()]);
});

const clientLogs = () => ingest.events().filter((event): event is LogEvent => event.type === 'log' && event.message === 'http.client');

describe('traceFetch', () => {
  it('logs each outgoing call with method, host, path without the query, status and duration, but not the calls to Radar', async () => {
    await fetch(`${api.url}/users/42/orders?token=abc#top`, { method: 'post', body: '{}' });
    await fetch(`${other.url}/down`);
    await client.flush();
    expect(clientLogs().map((event) => [event.level, event.attrs?.method, event.attrs?.host, event.attrs?.path, event.attrs?.status])).toEqual([
      ['info', 'POST', api.host, '/users/42/orders', 200],
      ['error', 'GET', other.host, '/down', 503],
    ]);
    expect(typeof clientLogs()[0]!.attrs?.durationMs).toBe('number');
    expect(JSON.stringify(clientLogs())).not.toContain('token=abc');
  });

  it('masks path segments that look like secrets', async () => {
    await fetch(`${api.url}/bot123456789:AAH-secretTelegramTokenWithLength/sendMessage`);
    await fetch(`${api.url}/v1/keys/sk_live_51HxQe2LkdIwHu7ixcsMlS9/charges`);
    await fetch(`${api.url}/orders/7f9c2d4e-8a1b-4c3d-9e2f-112233445566`);
    await client.flush();
    const paths = clientLogs().map((event) => String(event.attrs?.path));
    expect(paths[0]).toMatch(/^\/[^/]*#[0-9a-f]{8}\/sendMessage$/);
    expect(paths[1]).toMatch(/^\/v1\/keys\/[^/]*#[0-9a-f]{8}\/charges$/);
    expect(paths.join(' ')).not.toContain('secretTelegram');
    expect(paths.join(' ')).not.toContain('51HxQe2LkdIwHu7ixcsMlS9');
    expect(paths[2]).toBe('/orders/7f9c2d4e-8a1b-4c3d-9e2f-112233445566');
  });

  it('sends the request id only to the chosen hosts, inside a request, keeping one already set', async () => {
    await runWithContext({ requestId: 'req-77', startedAt: 0 }, async () => {
      await fetch(`${api.url}/a`);
      await fetch(`${api.url}/b`, { headers: { 'x-request-id': 'mine' } });
      await fetch(new Request(`${api.url}/c`, { headers: { accept: 'application/json' } }));
      await fetch(`${other.url}/d`);
    });
    await fetch(`${api.url}/e`);
    expect(api.received.map((request) => [request.path, request.headers['x-request-id'] ?? null])).toEqual([
      ['/a', 'req-77'],
      ['/b', 'mine'],
      ['/c', 'req-77'],
      ['/e', null],
    ]);
    expect(api.received.find((request) => request.path === '/c')!.headers.accept).toBe('application/json');
    expect(other.received[0]!.headers['x-request-id']).toBeUndefined();
    await client.flush();
    expect(clientLogs().map((event) => [event.attrs?.path, event.requestId ?? null])).toEqual([
      ['/a', 'req-77'],
      ['/b', 'req-77'],
      ['/c', 'req-77'],
      ['/d', 'req-77'],
      ['/e', null],
    ]);
  });

  it('keeps the method and the body of a request forwarded as the second argument', async () => {
    const incoming = new Request('http://placeholder.test/orders', { method: 'POST', body: JSON.stringify({ item: 1 }), headers: { 'content-type': 'application/json' } });
    await runWithContext({ requestId: 'req-88', startedAt: 0 }, async () => {
      await fetch(`${api.url}/orders`, incoming);
    });
    expect(api.received.at(-1)).toMatchObject({ method: 'POST', path: '/orders', body: '{"item":1}', headers: { 'x-request-id': 'req-88', 'content-type': 'application/json' } });
    await client.flush();
    expect(clientLogs().at(-1)?.attrs).toMatchObject({ method: 'POST', path: '/orders', status: 200 });
  });

  it('records a call that never answered as an error and rethrows it', async () => {
    const closed = await startUpstream();
    await closed.close();
    await expect(fetch(`${closed.url}/unreachable`)).rejects.toThrow();
    await client.flush();
    const [log] = clientLogs();
    expect(log).toMatchObject({ level: 'error', attrs: { method: 'GET', host: closed.host, path: '/unreachable' } });
    expect(String(log!.attrs?.error)).toContain('ECONNREFUSED');
    expect(log!.attrs?.status).toBeUndefined();
  });

  it('puts the original fetch back on close and never wraps it without the option', async () => {
    expect(globalThis.fetch).not.toBe(originalFetch);
    await client.close();
    expect(globalThis.fetch).toBe(originalFetch);
    const plain = new RadarClient();
    plain.init({ key: 'rk_test', endpoint: ingest.url, captureUnhandled: false });
    expect(globalThis.fetch).toBe(originalFetch);
    await plain.close();
  });
});

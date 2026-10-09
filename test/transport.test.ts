import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogEvent } from '../src/protocol/index.js';
import { retryAfterMs, Transport, type TransportConfig } from '../src/transport.js';
import { startFakeIngest, type FakeIngest, type Responder } from './helpers/fake-ingest.js';

const servers: FakeIngest[] = [];
const transports: Transport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) transport.stop();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function log(message: string, extra: Partial<LogEvent> = {}): LogEvent {
  return { type: 'log', ts: Date.now(), level: 'info', message, ...extra };
}

async function serve(respond?: Responder): Promise<FakeIngest> {
  const server = await startFakeIngest(respond);
  servers.push(server);
  return server;
}

function createTransport(url: string, overrides: Partial<TransportConfig> = {}): Transport {
  const transport = new Transport({
    url: `${url}/api/v1/events`,
    key: 'rk_test',
    sdk: { name: '@oconde/radar', version: '0.0.0-test' },
    environment: 'test',
    flushIntervalMs: 60_000,
    ...overrides,
  });
  transports.push(transport);
  return transport;
}

describe('Transport', () => {
  it('sends queued events with the key and the envelope', async () => {
    const server = await serve();
    const transport = createTransport(server.url, { release: 'abc123' });
    transport.enqueue(log('first'));
    transport.enqueue(async () => log('second'));
    await transport.flush(2000);
    expect(server.received).toHaveLength(1);
    const [request] = server.received;
    expect(request!.path).toBe('/api/v1/events');
    expect(request!.headers.authorization).toBe('Bearer rk_test');
    expect(request!.batch).toMatchObject({ v: 1, sdk: { name: '@oconde/radar' }, environment: 'test', release: 'abc123' });
    expect(request!.batch.events.map((event) => (event as LogEvent).message)).toEqual(['first', 'second']);
  });

  it('sends automatically when the batch size is reached', async () => {
    const server = await serve();
    const transport = createTransport(server.url, { batchSize: 3 });
    for (const message of ['a', 'b', 'c']) transport.enqueue(log(message));
    await vi.waitFor(() => expect(server.received).toHaveLength(1));
  });

  it('sends on the interval', async () => {
    const server = await serve();
    const transport = createTransport(server.url, { flushIntervalMs: 50 });
    transport.enqueue(log('timer'));
    await vi.waitFor(() => expect(server.events()).toHaveLength(1));
  });

  it('compresses large batches with gzip', async () => {
    const server = await serve();
    const transport = createTransport(server.url);
    transport.enqueue(log('big', { attrs: { blob: 'x'.repeat(10_000) } }));
    await transport.flush(2000);
    expect(server.received[0]!.headers['content-encoding']).toBe('gzip');
    expect(server.events()).toHaveLength(1);
  });

  it('keeps the events and retries after a server error', async () => {
    const server = await serve((_, index) => (index === 0 ? { status: 503 } : { status: 202, body: { accepted: 1, dropped: 0 } }));
    const transport = createTransport(server.url);
    transport.enqueue(log('retry me'));
    await transport.flush(500);
    expect(transport.pending).toBe(1);
    await vi.waitFor(
      async () => {
        await transport.flush(500);
        expect(server.received).toHaveLength(2);
      },
      { timeout: 5000, interval: 200 },
    );
    expect(transport.pending).toBe(0);
  });

  it('honors Retry-After on 429', async () => {
    const server = await serve(() => ({ status: 429, headers: { 'retry-after': '120' } }));
    const transport = createTransport(server.url);
    transport.enqueue(log('quota'));
    await transport.flush(500);
    await transport.flush(500);
    expect(server.received).toHaveLength(1);
    expect(transport.pending).toBe(1);
  });

  it('pauses, drops the queue and warns once on 401', async () => {
    const warnings: string[] = [];
    const server = await serve(() => ({ status: 401, body: { error: { code: 'invalid_key', message: 'x' } } }));
    const transport = createTransport(server.url, { onWarning: (message) => warnings.push(message) });
    transport.enqueue(log('a'));
    transport.enqueue(log('b'));
    await transport.flush(500);
    transport.enqueue(log('c'));
    await transport.flush(500);
    expect(server.received).toHaveLength(1);
    expect(transport.pending).toBe(1);
    expect(transport.dropped).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  it('counts events dropped by a full queue and reports them in the next batch', async () => {
    const server = await serve();
    const transport = createTransport(server.url, { maxQueue: 2, batchSize: 10 });
    transport.enqueue(log('1'));
    transport.enqueue(log('2'));
    transport.enqueue(log('3'));
    expect(transport.dropped).toBe(1);
    await transport.flush(2000);
    expect(server.received[0]!.batch.dropped).toBe(1);
    expect(transport.dropped).toBe(0);
  });

  it('drops a rejected batch and moves on', async () => {
    const server = await serve((_, index) => (index === 0 ? { status: 400 } : { status: 202 }));
    const transport = createTransport(server.url);
    transport.enqueue(log('bad'));
    await transport.flush(1000);
    transport.enqueue(log('good'));
    await transport.flush(1000);
    expect(server.received).toHaveLength(2);
    expect(server.received[1]!.batch.dropped).toBe(1);
  });

  it('never throws and returns within the timeout when the server is unreachable', async () => {
    const transport = createTransport('http://127.0.0.1:9');
    transport.enqueue(log('lost'));
    const started = Date.now();
    await expect(transport.flush(1000)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(transport.pending).toBe(1);
  });

  it('drops events whose enrichment failed', async () => {
    const server = await serve();
    const transport = createTransport(server.url);
    transport.enqueue(() => Promise.reject(new Error('enrichment failed')));
    transport.enqueue(log('ok'));
    await transport.flush(1000);
    expect(server.events()).toHaveLength(1);
    expect(server.received[0]!.batch.dropped).toBe(1);
  });

  it('splits batches above the size budget', async () => {
    const server = await serve();
    const transport = createTransport(server.url);
    for (let index = 0; index < 3; index++) transport.enqueue(log(`big ${index}`, { attrs: { blob: 'x'.repeat(400_000) } }));
    await transport.flush(5000);
    expect(server.received).toHaveLength(2);
    expect(server.events()).toHaveLength(3);
  });

  it('never follows a redirect, so events and the key never reach another host', async () => {
    const other = await serve();
    const server = await serve(() => ({ status: 307, headers: { location: `${other.url}/api/v1/events` } }));
    const transport = createTransport(server.url);
    transport.enqueue(log('stay here'));
    await transport.flush(1000);
    expect(server.received).toHaveLength(1);
    expect(other.received).toHaveLength(0);
    expect(transport.pending).toBe(1);
  });

  it('caps the wait a server can ask for at one day', () => {
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs(String(365 * 86_400))).toBe(86_400_000);
    expect(retryAfterMs(new Date(Date.now() + 30 * 86_400_000).toUTCString())).toBe(86_400_000);
    expect(retryAfterMs('nonsense')).toBeUndefined();
  });
});

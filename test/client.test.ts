import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RadarClient } from '../src/client.js';
import { runWithContext } from '../src/context.js';
import type { ErrorEvent, LogEvent } from '../src/protocol/index.js';
import { startFakeIngest, type FakeIngest } from './helpers/fake-ingest.js';

let server: FakeIngest;
let client: RadarClient;

beforeEach(async () => {
  server = await startFakeIngest();
  client = new RadarClient();
  client.init({ key: 'rk_test', endpoint: server.url, environment: 'test', release: 'r1', captureUnhandled: false });
});

afterEach(async () => {
  await client.close();
  await server.close();
});

const logs = () => server.events().filter((event): event is LogEvent => event.type === 'log');
const errors = () => server.events().filter((event): event is ErrorEvent => event.type === 'error');

describe('RadarClient logs', () => {
  it('sends logs with attributes and respects minLevel', async () => {
    client.debug('ignored');
    client.info('webhook.olx.lead', { leadId: 42 });
    client.warn('slow', { ms: 900 });
    client.error('failed', { reason: 'x' });
    await client.flush();
    expect(logs().map((event) => [event.level, event.message, event.attrs])).toEqual([
      ['info', 'webhook.olx.lead', { leadId: 42 }],
      ['warn', 'slow', { ms: 900 }],
      ['error', 'failed', { reason: 'x' }],
    ]);
    expect(server.received[0]!.batch).toMatchObject({ environment: 'test', release: 'r1' });
  });

  it('attaches requestId and user from the context', async () => {
    await runWithContext({ requestId: 'req-1', startedAt: 0 }, async () => {
      client.setUser({ id: 'u1', email: 'ana@example.com' });
      client.info('inside');
    });
    await client.flush();
    expect(logs()[0]).toMatchObject({ requestId: 'req-1', user: { id: 'u1', email: 'ana@example.com' } });
  });

  it('ignores setUser outside a context', async () => {
    client.setUser({ id: 'u1' });
    client.info('outside');
    await client.flush();
    expect(logs()[0]!.user).toBeUndefined();
  });

  it('ignores a second init', async () => {
    client.init({ key: 'rk_other', endpoint: 'http://127.0.0.1:9' });
    client.info('still here');
    await client.flush();
    expect(logs()).toHaveLength(1);
  });

  it('does nothing without a key', async () => {
    const silent = new RadarClient();
    silent.init({ captureUnhandled: false });
    silent.info('nobody listens');
    await silent.flush();
    expect(silent.isEnabled).toBe(false);
  });

  it('prints JSON lines with console enabled even without a key', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const local = new RadarClient();
    local.init({ console: true, captureUnhandled: false });
    local.info('api listening', { port: 8080 });
    spy.mockRestore();
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', message: 'api listening', port: 8080 });
  });

  it('never throws on bad input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => client.info(undefined as unknown as string, circular)).not.toThrow();
    expect(() => client.captureError(undefined)).not.toThrow();
  });

  it('ignores events after close', async () => {
    await client.close();
    client.info('late');
    await client.flush();
    expect(server.events()).toHaveLength(0);
  });
});

describe('RadarClient errors', () => {
  it('captures an error once with stack, runtime and attributes', async () => {
    const error = new TypeError('boom');
    client.captureError(error, { storeId: 7 });
    client.captureError(error);
    await client.flush();
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatchObject({
      level: 'error',
      handled: true,
      exception: { type: 'TypeError', message: 'boom' },
      attrs: { storeId: 7 },
      runtime: { name: 'node', version: process.versions.node },
    });
    expect(errors()[0]!.exception.frames.length).toBeGreaterThan(0);
  });

  it('track logs duration and success inside a fresh context', async () => {
    const result = await client.track('olx.sync', async () => 'done', { storeId: 1 });
    await client.flush();
    expect(result).toBe('done');
    expect(logs()[0]).toMatchObject({ level: 'info', message: 'olx.sync', attrs: { storeId: 1, ok: true } });
    expect(typeof logs()[0]!.attrs!.durationMs).toBe('number');
    expect(typeof logs()[0]!.requestId).toBe('string');
  });

  it('track captures, logs and rethrows failures', async () => {
    await expect(
      client.track('olx.sync', async () => {
        throw new Error('olx down');
      }),
    ).rejects.toThrow('olx down');
    await client.flush();
    expect(logs()[0]).toMatchObject({ level: 'error', message: 'olx.sync', attrs: { ok: false } });
    expect(errors()[0]!.exception.message).toBe('olx down');
    expect(errors()[0]!.requestId).toBe(logs()[0]!.requestId);
  });

  it('track keeps the outer context when there is one', async () => {
    await runWithContext({ requestId: 'outer', startedAt: 0 }, () => client.track('inner.step', () => 1));
    await client.flush();
    expect(logs()[0]!.requestId).toBe('outer');
  });
});

describe('RadarClient.withContext', () => {
  it('runs a job in a fresh context with its own requestId and returns the result', async () => {
    const result = await client.withContext(async () => {
      client.info('job.started');
      client.setUser({ id: 'worker' });
      client.info('job.finished');
      return 42;
    });
    expect(result).toBe(42);
    await client.flush();
    const [started, finished] = logs();
    expect(started!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(finished!.requestId).toBe(started!.requestId);
    expect(finished!.user).toEqual({ id: 'worker' });
  });

  it('uses a given requestId and never reuses the outer context', async () => {
    await runWithContext({ requestId: 'outer', startedAt: 0 }, async () => {
      await client.withContext(() => client.info('inner'), { requestId: 'run-7' });
      client.withContext(() => client.info('fresh'));
    });
    await client.flush();
    const ids = logs().map((event) => event.requestId);
    expect(ids[0]).toBe('run-7');
    expect(ids[1]).not.toBe('outer');
    expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects an oversized requestId and propagates errors', () => {
    client.withContext(() => client.info('long'), { requestId: 'x'.repeat(200) });
    expect(() => client.withContext(() => { throw new Error('job failed'); })).toThrow('job failed');
  });
});

describe('RadarClient when Radar is down', () => {
  it('flush resolves within the timeout', async () => {
    const offline = new RadarClient();
    offline.init({ key: 'rk_test', endpoint: 'http://127.0.0.1:9', captureUnhandled: false });
    offline.info('lost');
    const started = Date.now();
    await offline.flush(800);
    await offline.close(200);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

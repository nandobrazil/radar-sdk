import { afterEach, describe, expect, it, vi } from 'vitest';
import { RadarClient } from '../src/client.js';
import type { ErrorEvent, LogEvent } from '../src/protocol/index.js';
import { startFakeIngest, type FakeIngest, type Responder } from './helpers/fake-ingest.js';

const servers: FakeIngest[] = [];
const clients: RadarClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

async function setup(respond?: Responder, options: { debug?: boolean } = {}) {
  const server = await startFakeIngest(respond);
  servers.push(server);
  const client = new RadarClient();
  clients.push(client);
  client.init({ key: 'rk_test', endpoint: server.url, environment: 'production', release: 'abc123', captureUnhandled: false, ...options });
  return { server, client, checkIns: () => server.received.filter((request) => request.path.startsWith('/api/v1/checkins/')) };
}

describe('radar.checkIn', () => {
  it('posts the status right away to the check-in endpoint with environment and release', async () => {
    const { client, checkIns } = await setup();
    await client.checkIn('walg-archive-check', 'in_progress', { checkInId: 'run-1' });
    await client.checkIn('walg-archive-check', 'ok', { checkInId: 'run-1', durationMs: 1234 });
    expect(checkIns().map((request) => [request.method, request.path, request.headers.authorization, request.body])).toEqual([
      ['POST', '/api/v1/checkins/walg-archive-check', 'Bearer rk_test', { status: 'in_progress', checkInId: 'run-1', environment: 'production', release: 'abc123' }],
      ['POST', '/api/v1/checkins/walg-archive-check', 'Bearer rk_test', { status: 'ok', checkInId: 'run-1', durationMs: 1234, environment: 'production', release: 'abc123' }],
    ]);
  });

  it('never throws and skips invalid slugs, statuses and disabled clients', async () => {
    const { client, checkIns } = await setup();
    await expect(client.checkIn('Bad Slug', 'ok')).resolves.toBeUndefined();
    await expect(client.checkIn('job', 'done' as 'ok')).resolves.toBeUndefined();
    const disabled = new RadarClient();
    clients.push(disabled);
    await expect(disabled.checkIn('job', 'ok')).resolves.toBeUndefined();
    expect(checkIns()).toEqual([]);
  });

  it('does not throw when the Radar is down', async () => {
    const client = new RadarClient();
    clients.push(client);
    client.init({ key: 'rk_test', endpoint: 'http://127.0.0.1:9', captureUnhandled: false });
    await expect(client.checkIn('job', 'ok')).resolves.toBeUndefined();
  });

  it('warns once about an unknown slug', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { client } = await setup(() => ({ status: 404, body: { error: { code: 'unknown_monitor', message: 'x' } } }));
    await client.checkIn('ghost', 'ok');
    await client.checkIn('ghost', 'ok');
    const warnings = write.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('ghost'));
    expect(warnings).toHaveLength(1);
  });

  it('shares the 401 pause with the event transport', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { client, server, checkIns } = await setup(() => ({ status: 401, body: { error: { code: 'invalid_key', message: 'x' } } }));
    await client.checkIn('job', 'ok');
    await client.checkIn('job', 'ok');
    client.info('after.pause');
    await client.flush();
    expect(checkIns()).toHaveLength(1);
    expect(server.received.filter((request) => request.path === '/api/v1/events')).toEqual([]);
  });
});

describe('radar.cron', () => {
  it('wraps a job with in_progress and ok, inside its own context', async () => {
    const { client, server, checkIns } = await setup();
    const result = await client.cron('walg-base-backup', async () => {
      client.info('backup.done');
      return 'done';
    });
    expect(result).toBe('done');
    await client.flush();
    const [start, finish] = checkIns().map((request) => request.body as Record<string, unknown>);
    expect(start).toMatchObject({ status: 'in_progress' });
    expect(finish).toMatchObject({ status: 'ok', checkInId: start!.checkInId });
    expect(typeof finish!.durationMs).toBe('number');
    const log = server.events().find((event): event is LogEvent => event.type === 'log' && event.message === 'backup.done');
    expect(log!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports error, captures and rethrows a failing job', async () => {
    const { client, server, checkIns } = await setup();
    await expect(client.cron('dump', () => Promise.reject(new Error('disk full')))).rejects.toThrow('disk full');
    await client.flush();
    expect(checkIns().map((request) => (request.body as { status: string }).status)).toEqual(['in_progress', 'error']);
    const error = server.events().find((event): event is ErrorEvent => event.type === 'error');
    expect(error!.exception.message).toBe('disk full');
    expect(error!.attrs).toEqual({ cron: 'dump' });
  });
});

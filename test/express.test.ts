import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RadarClient } from '../src/client.js';
import type { LogEvent } from '../src/protocol/index.js';
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

function buildApp() {
  const app = express();
  app.use(client.middleware());
  app.use(express.json());
  app.post('/stores/:storeId/leads', (_req, res) => {
    client.setUser({ id: 'u1' });
    client.logRequest('Lead recebido', { source: 'olx' });
    res.status(201).json({ ok: true });
  });
  app.post('/photos', express.raw({ type: 'image/jpeg', limit: '3mb' }), (_req, res) => {
    client.logRequest('Foto recebida');
    res.status(204).end();
  });
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('middleware', () => {
  it('reuses a valid x-request-id or generates one', async () => {
    const app = buildApp();
    const generated = await request(app).get('/healthz');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const reused = await request(app).get('/healthz').set('x-request-id', 'abc-123');
    expect(reused.headers['x-request-id']).toBe('abc-123');
    const tooLong = await request(app).get('/healthz').set('x-request-id', 'x'.repeat(200));
    expect(tooLong.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logRequest captures the full request with masked secrets', async () => {
    await request(buildApp())
      .post('/stores/42/leads?token=abcdefghijklmnop&page=2')
      .set('authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')
      .set('x-request-id', 'req-9')
      .send({ name: 'Ana', password: 'super-secret-password' })
      .expect(201);
    await client.flush();
    const event = logs().find((item) => item.message === 'Lead recebido')!;
    expect(event.requestId).toBe('req-9');
    expect(event.user).toEqual({ id: 'u1' });
    expect(event.attrs).toEqual({ source: 'olx' });
    expect(event.request).toMatchObject({
      method: 'POST',
      route: '/stores/:storeId/leads',
      params: { storeId: '42' },
      query: { page: '2' },
      body: { name: 'Ana' },
    });
    expect(event.request!.url).not.toContain('abcdefghijklmnop');
    expect(event.request!.headers!.authorization).toMatch(/^Bearer eyJh…\.sig #[0-9a-f]{8}$/);
    expect((event.request!.body as { password: string }).password).toMatch(/^supe…word #/);
  });

  it('never sends raw binary bodies', async () => {
    await request(buildApp()).post('/photos').set('content-type', 'image/jpeg').send(Buffer.alloc(2_000_000)).expect(204);
    await client.flush();
    const event = logs().find((item) => item.message === 'Foto recebida')!;
    expect(event.request!.body).toBe('[binário 2000000 bytes]');
  });

  it('logs every request as http.request except ignored paths', async () => {
    const app = buildApp();
    await request(app).post('/stores/1/leads').send({}).expect(201);
    await request(app).get('/healthz').expect(200);
    await request(app).get('/missing').expect(404);
    await vi.waitFor(async () => {
      await client.flush();
      expect(logs().filter((item) => item.message === 'http.request')).toHaveLength(2);
    });
    const http = logs().filter((item) => item.message === 'http.request');
    expect(http.map((item) => [item.level, item.attrs!.path, item.attrs!.status])).toEqual([
      ['info', '/stores/1/leads', 201],
      ['warn', '/missing', 404],
    ]);
    expect(http[0]!.attrs).toMatchObject({ method: 'POST', route: '/stores/:storeId/leads' });
    expect(typeof http[0]!.attrs!.durationMs).toBe('number');
    expect(http[0]!.requestId).toBeTypeOf('string');
  });

  it('logRequest outside a request is a plain log', async () => {
    client.logRequest('no request here');
    await client.flush();
    expect(logs()[0]!.request).toBeUndefined();
  });
});

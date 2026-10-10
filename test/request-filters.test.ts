import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RadarClient } from '../src/client.js';
import type { RadarOptions } from '../src/options.js';
import type { LogEvent } from '../src/protocol/index.js';
import { startFakeIngest, type FakeIngest } from './helpers/fake-ingest.js';

let server: FakeIngest;
let client: RadarClient;

beforeEach(async () => {
  server = await startFakeIngest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await client.close();
  await server.close();
});

function start(logRequests: RadarOptions['logRequests']) {
  client = new RadarClient();
  client.init({ key: 'rk_test', endpoint: server.url, environment: 'test', captureUnhandled: false, logRequests });
  const app = express();
  app.use(client.middleware());
  const admin = express.Router();
  admin.get('/stores/:storeId', (_req, res) => void res.json({ ok: true }));
  admin.get('/ping', (_req, res) => void res.json({ ok: true }));
  app.use('/dashboard', admin);
  app.get('/:slug', (_req, res) => void res.json({ ok: true }));
  app.get('/api/orders/:id', (_req, res) => void res.status(500).json({ ok: false }));
  return app;
}

async function logged(): Promise<{ route: unknown; path: unknown; sampleRate: unknown }[]> {
  await client.flush();
  return server
    .events()
    .filter((event): event is LogEvent => event.type === 'log' && event.message === 'http.request')
    .map((event) => ({ route: event.attrs?.route, path: event.attrs?.path, sampleRate: event.attrs?.sampleRate }));
}

describe('logRequests filters', () => {
  it('logs only the included paths or routes, minus the excluded ones', async () => {
    const app = start({ include: ['/dashboard', /^\/api\//], exclude: ['/dashboard/ping'] });
    for (const path of ['/dashboard/stores/42', '/dashboard/ping', '/minha-arvore', '/api/orders/7', '/dashboardx']) await request(app).get(path);
    expect((await logged()).map((entry) => entry.path)).toEqual(['/dashboard/stores/42', '/api/orders/7']);
  });

  it('matches the framework route as well as the path', async () => {
    const app = start({ include: ['/dashboard/stores/:storeId'] });
    await request(app).get('/dashboard/stores/42');
    await request(app).get('/dashboard/ping');
    expect(await logged()).toEqual([{ route: '/dashboard/stores/:storeId', path: '/dashboard/stores/42', sampleRate: undefined }]);
  });

  it('logs no request with a sample of 0', async () => {
    const app = start({ sample: 0 });
    for (let index = 0; index < 20; index++) await request(app).get(`/item-${index}`);
    expect(await logged()).toEqual([]);
  });

  it('keeps a uniform sample and says the rate on each kept request', async () => {
    const app = start({ sample: 0.25 });
    const draws = [0.1, 0.9, 0.24, 0.25];
    vi.spyOn(Math, 'random').mockImplementation(() => draws.shift() ?? 0.99);
    for (const id of [1, 2, 3, 4]) await request(app).get(`/api/orders/${id}`);
    expect((await logged()).map((entry) => [entry.path, entry.sampleRate])).toEqual([
      ['/api/orders/1', 0.25],
      ['/api/orders/3', 0.25],
    ]);
  });

  it('still logs everything with logRequests: true and nothing with false', async () => {
    const all = start(true);
    await request(all).get('/minha-arvore');
    expect(await logged()).toHaveLength(1);
    await client.close();
    await server.close();
    server = await startFakeIngest();
    const none = start(false);
    await request(none).get('/minha-arvore');
    expect(await logged()).toEqual([]);
  });
});

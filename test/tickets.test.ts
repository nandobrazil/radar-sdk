import { afterEach, describe, expect, it, vi } from 'vitest';
import { RadarClient } from '../src/client.js';
import { startFakeIngest, type FakeIngest, type Responder } from './helpers/fake-ingest.js';

const servers: FakeIngest[] = [];
const clients: RadarClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

async function setup(respond?: Responder) {
  const server = await startFakeIngest(respond);
  servers.push(server);
  const client = new RadarClient();
  clients.push(client);
  client.init({ key: 'rk_test', endpoint: server.url, environment: 'production', release: 'abc123', captureUnhandled: false });
  return { server, client, tickets: () => server.received.filter((request) => request.path.startsWith('/api/v1/tickets')) };
}

describe('tickets', () => {
  it('opens a ticket with the environment and release of the client and returns its number', async () => {
    const { client, tickets } = await setup(() => ({ status: 201, body: { id: 't1', number: 7, status: 'open', url: 'https://radar.test/projects/loja/tickets/t1' } }));
    const created = await client.createTicket({ kind: 'bug', title: 'Botão não responde', body: 'Cliquei e nada', reporter: { id: 'u1', name: 'Ana', email: 'ana@example.com' }, attrs: { screen: 'checkout' } });
    expect(created).toEqual({ id: 't1', number: 7, status: 'open', url: 'https://radar.test/projects/loja/tickets/t1' });
    expect(tickets().map((request) => [request.method, request.path, request.headers.authorization, request.body])).toEqual([
      ['POST', '/api/v1/tickets', 'Bearer rk_test', { kind: 'bug', title: 'Botão não responde', body: 'Cliquei e nada', reporter: { id: 'u1', name: 'Ana', email: 'ana@example.com' }, attrs: { screen: 'checkout' }, environment: 'production', release: 'abc123' }],
    ]);
  });

  it('returns null instead of throwing when Radar fails or the network is down', async () => {
    const { client } = await setup(() => ({ status: 500, body: { error: { code: 'internal', message: 'boom' } } }));
    await expect(client.createTicket({ kind: 'question', title: 'x', body: 'y' })).resolves.toBeNull();
    const offline = new RadarClient();
    clients.push(offline);
    offline.init({ key: 'rk_test', endpoint: 'http://127.0.0.1:9', captureUnhandled: false });
    await expect(offline.listTickets({ reporterId: 'u1' })).resolves.toBeNull();
    const disabled = new RadarClient();
    clients.push(disabled);
    disabled.init({ enabled: false });
    await expect(disabled.createTicket({ kind: 'bug', title: 'x', body: 'y' })).resolves.toBeNull();
  });

  it('lists the tickets of one customer, reads one and answers as that customer', async () => {
    const summary = { id: 't1', number: 7, kind: 'bug', status: 'answered', title: 'Botão', messageCount: 2, lastMessageAt: '2026-10-22T12:00:00.000Z', lastMessageBy: 'member', createdAt: '2026-10-22T11:00:00.000Z' };
    const messages = [{ author: 'reporter', authorName: 'Ana', body: 'Cliquei e nada', createdAt: '2026-10-22T11:00:00.000Z' }, { author: 'member', authorName: 'Equipe', body: 'Corrigido', createdAt: '2026-10-22T12:00:00.000Z' }];
    const { client, tickets } = await setup((request) => {
      if (request.method === 'POST') return { status: 201, body: { id: 't1', number: 7, status: 'open' } };
      if (request.path.startsWith('/api/v1/tickets/t1')) return { status: 200, body: { ...summary, reporter: { id: 'u 1', name: 'Ana' }, messages } };
      if (request.path.startsWith('/api/v1/tickets/t2')) return { status: 404, body: { error: { code: 'not_found', message: 'x' } } };
      return { status: 200, body: { tickets: [summary] } };
    });
    const list = await client.listTickets({ reporterId: 'u 1', status: 'answered', limit: 5 });
    expect(list?.map((ticket) => [ticket.number, ticket.status])).toEqual([[7, 'answered']]);
    const detail = await client.getTicket('t1', { reporterId: 'u 1' });
    expect(detail?.messages.map((message) => [message.author, message.body])).toEqual([['reporter', 'Cliquei e nada'], ['member', 'Corrigido']]);
    await expect(client.getTicket('t2', { reporterId: 'u 1' })).resolves.toBeNull();
    const replied = await client.replyTicket('t1', 'Ainda acontece', { id: 'u 1', name: 'Ana' });
    expect(replied).toEqual({ id: 't1', number: 7, status: 'open' });
    expect(tickets().map((request) => [request.method, request.path, request.body])).toEqual([
      ['GET', '/api/v1/tickets?reporter=u+1&status=answered&limit=5', null],
      ['GET', '/api/v1/tickets/t1?reporter=u+1', null],
      ['GET', '/api/v1/tickets/t2?reporter=u+1', null],
      ['POST', '/api/v1/tickets/t1/messages?reporter=u+1', { body: 'Ainda acontece', reporter: { name: 'Ana' } }],
    ]);
  });
});

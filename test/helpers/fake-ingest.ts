import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import type { EventBatch, RadarEvent } from '../../src/protocol/index.js';

export type ReceivedRequest = { method: string; path: string; headers: IncomingHttpHeaders; batch: EventBatch; body: unknown };
export type FakeReply = { status: number; headers?: Record<string, string>; body?: unknown };
export type Responder = (request: ReceivedRequest, index: number) => FakeReply;
export type FakeIngest = { url: string; received: ReceivedRequest[]; events(): RadarEvent[]; close(): Promise<void> };

export async function startFakeIngest(respond: Responder = () => ({ status: 202, body: { accepted: 1, dropped: 0 } })): Promise<FakeIngest> {
  const received: ReceivedRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let raw = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw);
    const text = raw.toString('utf8');
    const body: unknown = text ? JSON.parse(text) : null;
    const entry: ReceivedRequest = { method: req.method ?? 'GET', path: req.url ?? '', headers: req.headers, batch: body as EventBatch, body };
    received.push(entry);
    const reply = respond(entry, received.length - 1);
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    events: () => received.filter((request) => request.path === '/api/v1/events').flatMap((request) => request.batch.events),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RadarClient } from '../src/client.js';
import type { LogEvent } from '../src/protocol/index.js';
import { fingerprint, isSensitiveHeader, isSensitiveKey, maskValue, redactDeep, setFingerprintSecret } from '../src/redact.js';
import { requestInfo } from '../src/request.js';
import { startFakeIngest, type FakeIngest } from './helpers/fake-ingest.js';

describe('secret names', () => {
  it.each(['apikey', 'api-key', 'x-token', 'token', 'x-hub-signature-256', 'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-olx-token', 'x-partner-key'])('header %s is masked', (name) => {
    expect(isSensitiveHeader(name)).toBe(true);
  });

  it.each(['x-request-id', 'content-type', 'idempotency-key', 'user-agent', 'accept'])('header %s is kept', (name) => {
    expect(isSensitiveHeader(name)).toBe(false);
  });

  it.each(['private_key', 'auth', 'signature', 'jwt', 'session', 'sessionId', 'key', 'accessToken', 'senhaAtual', 'cardNumber', 'client_secret', 'pin', 'otp'])('key %s is masked', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['cardio', 'cardio_machine', 'passos', 'cardapio', 'passagem', 'keyboard', 'monkey', 'sortKey', 'idempotencyKey', 'tokenizer'])('key %s is kept', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it('masks credential-looking values whatever the key', () => {
    const result = redactDeep({ note: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature', other: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc', plain: 'hello' }, 'mask') as Record<string, string>;
    expect(result.note).toMatch(/^Bearer eyJh…ture #[0-9a-f]{8}$/);
    expect(result.other).toMatch(/^eyJh….abc #[0-9a-f]{8}$|^eyJh…\.abc #[0-9a-f]{8}$/);
    expect(result.plain).toBe('hello');
  });
});

describe('fingerprints', () => {
  it('are keyed by the project key and never a plain sha256', () => {
    setFingerprintSecret('rk_first');
    const first = fingerprint('123.456.789-09');
    setFingerprintSecret('rk_second');
    const second = fingerprint('123.456.789-09');
    expect(first).not.toBe(second);
    expect(first).not.toBe(createHash('sha256').update('123.456.789-09').digest('hex').slice(0, 8));
    setFingerprintSecret('rk_first');
    expect(fingerprint('123.456.789-09')).toBe(first);
  });

  it('never reveal the edges of low-entropy secrets', () => {
    const result = redactDeep({ cpf: '123.456.789-09', password: 'minha-senha-longa-123', cvv: '123', token: 'abcdefghijklmnopqrstuvwxyz' }, 'mask') as Record<string, string>;
    expect(result.cpf).toMatch(/^••• #[0-9a-f]{8}$/);
    expect(result.password).toMatch(/^••• #[0-9a-f]{8}$/);
    expect(result.cvv).toMatch(/^••• #[0-9a-f]{8}$/);
    expect(result.token).toMatch(/^abcd…wxyz #[0-9a-f]{8}$/);
    expect(maskValue('abcdefghijklmnop', false)).toMatch(/^••• #/);
  });
});

describe('secrets in the url path', () => {
  it('masks sensitive route params inside the path', () => {
    const info = requestInfo(
      {
        method: 'POST',
        originalUrl: '/bot123456:AAH-secretTelegramToken/webhook/olx/supersecrettoken123?page=1',
        route: { path: '/bot:token/webhook/olx/:secret' },
        params: { token: '123456:AAH-secretTelegramToken', secret: 'supersecrettoken123' },
        headers: {},
      },
      'mask',
    );
    expect(info.url).not.toContain('AAH-secretTelegramToken');
    expect(info.url).not.toContain('supersecrettoken123');
    expect(info.url).toContain('/webhook/olx/');
    expect(info.url).toContain('page=1');
  });
});

describe('http.request path', () => {
  let server: FakeIngest;
  let client: RadarClient;

  beforeEach(async () => {
    server = await startFakeIngest();
    client = new RadarClient();
    client.init({ key: 'rk_test', endpoint: server.url, captureUnhandled: false });
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('does not leak secret route params in the automatic request log', async () => {
    const app = express();
    app.use(client.middleware());
    app.post('/webhook/:token', (_req, res) => {
      res.status(204).end();
    });
    await request(app).post('/webhook/supersecrettoken123').expect(204);
    await vi.waitFor(async () => {
      await client.flush();
      expect(server.events()).toHaveLength(1);
    });
    const log = server.events()[0] as LogEvent;
    expect(log.message).toBe('http.request');
    expect(JSON.stringify(log)).not.toContain('supersecrettoken123');
  });
});

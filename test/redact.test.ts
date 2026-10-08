import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprint, isSensitiveHeader, isSensitiveKey, maskValue, redactDeep } from '../src/redact.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8);

describe('maskValue', () => {
  it('keeps the scheme and the edges of a bearer token', () => {
    const token = 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature5x9Q';
    expect(maskValue(token)).toBe(`Bearer eyJh…5x9Q #${digest(token)}`);
  });

  it('hides short values entirely', () => {
    expect(maskValue('1234')).toBe(`••• #${digest('1234')}`);
  });

  it('stringifies non-string values', () => {
    expect(maskValue(123456)).toBe(`••• #${digest('123456')}`);
  });

  it('gives equal values the same fingerprint', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
  });
});

describe('sensitive names', () => {
  it.each(['authorization', 'Cookie', 'set-cookie', 'proxy-authorization', 'x-api-key', 'x-olx-token', 'x-webhook-secret', 'x-partner-key'])(
    'header %s is sensitive',
    (name) => expect(isSensitiveHeader(name)).toBe(true),
  );

  it.each(['content-type', 'user-agent', 'x-request-id'])('header %s is not sensitive', (name) => {
    expect(isSensitiveHeader(name)).toBe(false);
  });

  it.each(['password', 'senha', 'clientSecret', 'accessToken', 'api_key', 'apiKey', 'cpf', 'cardNumber', 'cvv'])('key %s is sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });
});

describe('redactDeep', () => {
  it('masks nested sensitive keys', () => {
    const result = redactDeep({ user: { senha: '123456789012345', name: 'Ana' }, items: [{ apiKey: 'k-1234567890123' }] }, 'mask') as {
      user: { senha: string; name: string };
      items: { apiKey: string }[];
    };
    expect(result.user.name).toBe('Ana');
    expect(result.user.senha).toMatch(/^1234…2345 #[0-9a-f]{8}$/);
    expect(result.items[0]!.apiKey).toMatch(/^k-12…0123 #[0-9a-f]{8}$/);
  });

  it('keeps everything with mode none', () => {
    expect(redactDeep({ token: 'abc' }, 'none')).toEqual({ token: 'abc' });
  });

  it('does not mask empty values', () => {
    expect(redactDeep({ token: '', secret: null }, 'mask')).toEqual({ token: '', secret: null });
  });
});

import { describe, expect, it } from 'vitest';
import type { RequestLike } from '../src/context.js';
import { currentContext, runWithContext } from '../src/context.js';
import { redactUrl, requestHeaders, requestInfo, requestPath, routeParams } from '../src/request.js';

const req: RequestLike = {
  method: 'post',
  originalUrl: '/stores/42/leads?token=abcdefghijklmnop&page=2',
  route: { path: '/stores/:storeId/leads' },
  params: { storeId: '42' },
  query: { token: 'abcdefghijklmnop', page: '2' },
  headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig', 'user-agent': 'OLX-Webhook/2', 'x-list': ['a', 'b'] },
  body: { name: 'Ana', password: 'super-secret-password' },
  ip: '10.0.0.1',
};

describe('requestInfo', () => {
  it('builds the snapshot with masked secrets', () => {
    const info = requestInfo(req, 'mask', { status: 201, durationMs: 12 });
    expect(info).toMatchObject({
      method: 'POST',
      route: '/stores/:storeId/leads',
      params: { storeId: '42' },
      ip: '10.0.0.1',
      userAgent: 'OLX-Webhook/2',
      status: 201,
      durationMs: 12,
    });
    expect(info.url).not.toContain('abcdefghijklmnop');
    expect(info.url).toContain('page=2');
    expect(info.query).toEqual({ page: '2', token: expect.stringMatching(/^abcd…mnop #[0-9a-f]{8}$/) });
    expect(info.headers).toEqual({
      authorization: expect.stringMatching(/^Bearer eyJh…\.sig #[0-9a-f]{8}$/),
      'user-agent': 'OLX-Webhook/2',
      'x-list': 'a, b',
    });
    expect(info.body).toEqual({ name: 'Ana', password: expect.stringMatching(/^••• #[0-9a-f]{8}$/) });
  });

  it('keeps everything with redact none', () => {
    const info = requestInfo(req, 'none');
    expect(info.url).toBe(req.originalUrl);
    expect(info.headers!.authorization).toBe('Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(info.body).toEqual({ name: 'Ana', password: 'super-secret-password' });
  });

  it('describes binary bodies instead of sending them', () => {
    expect(requestInfo({ ...req, body: Buffer.alloc(2_000_000) }, 'mask').body).toBe('[binário 2000000 bytes]');
  });

  it('truncates large bodies', () => {
    const info = requestInfo({ ...req, body: { items: Array.from({ length: 40 }, () => 'x'.repeat(1000)) } }, 'mask');
    expect(info.body).toHaveProperty('_truncated');
  });

  it('omits empty bodies, params and query', () => {
    expect(requestInfo({ method: 'GET', url: '/healthz', headers: {}, body: {}, params: {}, query: {} }, 'mask')).toEqual({
      method: 'GET',
      url: '/healthz',
      headers: {},
    });
  });

  it('prefers the route given by the framework', () => {
    expect(requestInfo(req, 'mask', { route: '/v1/leads' }).route).toBe('/v1/leads');
  });

  it('falls back to the socket address', () => {
    expect(requestInfo({ url: '/', headers: {}, socket: { remoteAddress: '::1' } }, 'mask').ip).toBe('::1');
  });
});

describe('requestHeaders', () => {
  it('keeps at most 50 headers', () => {
    const headers = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`x-h${index}`, String(index)]));
    expect(Object.keys(requestHeaders(headers, 'mask'))).toHaveLength(50);
  });
});

describe('redactUrl and requestPath', () => {
  it('leaves urls without sensitive params untouched', () => expect(redactUrl('/a?page=1', 'mask')).toBe('/a?page=1'));
  it('strips the query string from the path', () => expect(requestPath({ originalUrl: '/a/b?x=1', headers: {} })).toBe('/a/b'));
});

describe('context', () => {
  it('isolates concurrent contexts', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['one', 'two'].map((requestId) =>
        runWithContext({ requestId, startedAt: 0 }, async () => {
          await new Promise((resolve) => setTimeout(resolve, requestId === 'one' ? 20 : 5));
          seen.push(currentContext()!.requestId);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['one', 'two']);
    expect(currentContext()).toBeUndefined();
  });
});

describe('routeParams', () => {
  const req = (route: string | undefined, baseUrl = '') => ({ headers: {}, baseUrl, ...(route ? { route: { path: route } } : {}) });

  it('reads params from the route pattern aligned to the end of the path', () => {
    expect(routeParams(req('/reset/:token'), '/reset/abc')).toEqual({ token: 'abc' });
    expect(routeParams(req('/accounts/:accountId/reset/:token'), '/api/accounts/42/reset/abc')).toEqual({ accountId: '42', token: 'abc' });
    expect(routeParams(req('/reset/:token', '/api'), '/api/reset/abc')).toEqual({ token: 'abc' });
  });

  it('ignores a trailing slash and decodes values', () => {
    expect(routeParams(req('/reset/:token'), '/reset/a%2Fb%20c/')).toEqual({ token: 'a/b c' });
  });

  it('returns nothing without a route or when the static segments do not match', () => {
    expect(routeParams(req(undefined), '/reset/abc')).toEqual({});
    expect(routeParams(req('/reset/:token'), '/other/abc')).toEqual({});
    expect(routeParams(req('/a/b/:token'), '/b/abc')).toEqual({});
  });
});


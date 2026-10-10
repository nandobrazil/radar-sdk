import { describe, expect, it } from 'vitest';
import { DEFAULT_ENDPOINT, levelEnabled, resolveOptions } from '../src/options.js';

describe('resolveOptions', () => {
  it('stays disabled without a key and applies defaults', () => {
    const options = resolveOptions({}, {});
    expect(options).toEqual({
      key: undefined,
      endpoint: DEFAULT_ENDPOINT,
      environment: 'production',
      release: undefined,
      enabled: false,
      console: false,
      minLevel: 'info',
      redact: 'mask',
      requestDetail: 'full',
      logRequests: { enabled: true, include: [], exclude: [], sample: 1 },
      ignorePaths: ['/healthz', '/health'],
      captureUnhandled: true,
      traceFetch: { enabled: false, propagateTo: [], ignore: [] },
      debug: false,
    });
  });

  it('enables with a trimmed key and reads NODE_ENV', () => {
    const options = resolveOptions({ key: ' rk_abc ' }, { NODE_ENV: 'staging' });
    expect(options.enabled).toBe(true);
    expect(options.key).toBe('rk_abc');
    expect(options.environment).toBe('staging');
  });

  it('removes trailing slashes from the endpoint', () => {
    expect(resolveOptions({ endpoint: 'http://localhost:5173//' }, {}).endpoint).toBe('http://localhost:5173');
  });

  it('falls back to safe values for invalid input', () => {
    const options = resolveOptions({ minLevel: 'loud' as never, redact: 'partial' as never }, {});
    expect(options.minLevel).toBe('info');
    expect(options.redact).toBe('mask');
  });
});

describe('levelEnabled', () => {
  it('compares levels by severity', () => {
    expect(levelEnabled('debug', 'info')).toBe(false);
    expect(levelEnabled('info', 'info')).toBe(true);
    expect(levelEnabled('error', 'warn')).toBe(true);
  });

  it('turns traceFetch on with or without hosts to propagate to, and off by default', () => {
    expect(resolveOptions({}, {}).traceFetch).toEqual({ enabled: false, propagateTo: [], ignore: [] });
    expect(resolveOptions({ traceFetch: true }, {}).traceFetch).toEqual({ enabled: true, propagateTo: [], ignore: [] });
    expect(resolveOptions({ traceFetch: { propagateTo: ['api.spinlab.dev', ' ', /\.oconde\.dev$/, 42 as unknown as string] } }, {}).traceFetch).toEqual({ enabled: true, propagateTo: ['api.spinlab.dev', /\.oconde\.dev$/], ignore: [] });
    expect(resolveOptions({ traceFetch: { ignore: ['api.telegram.org', '', /getUpdates/] } }, {}).traceFetch).toEqual({ enabled: true, propagateTo: [], ignore: ['api.telegram.org', /getUpdates/] });
  });

  it('reads logRequests as a switch or as filters with a sample rate', () => {
    expect(resolveOptions({ logRequests: false }, {}).logRequests).toEqual({ enabled: false, include: [], exclude: [], sample: 1 });
    expect(resolveOptions({ logRequests: { include: ['/dashboard', ' ', /^\/api\//], exclude: ['/dashboard/ping'], sample: 0.25 } }, {}).logRequests).toEqual({
      enabled: true,
      include: ['/dashboard', /^\/api\//],
      exclude: ['/dashboard/ping'],
      sample: 0.25,
    });
    for (const sample of [0, -1, 1.5, Number.NaN, '0.5' as unknown as number]) expect(resolveOptions({ logRequests: { sample } }, {}).logRequests.sample).toBe(1);
  });
});


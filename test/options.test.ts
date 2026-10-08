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
      logRequests: true,
      ignorePaths: ['/healthz', '/health'],
      captureUnhandled: true,
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
});

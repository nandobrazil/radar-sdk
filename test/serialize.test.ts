import { describe, expect, it } from 'vitest';
import { limitBytes, prepareAttrs, sanitize, truncate, TRUNCATED } from '../src/serialize.js';

describe('truncate', () => {
  it('keeps short strings', () => expect(truncate('abc', 5)).toBe('abc'));
  it('cuts long strings with a marker', () => expect(truncate('abcdef', 3)).toBe(`abc${TRUNCATED}`));
});

describe('sanitize', () => {
  it('replaces circular references', () => {
    const value: Record<string, unknown> = { name: 'a' };
    value.self = value;
    expect(sanitize(value)).toEqual({ name: 'a', self: '[circular]' });
  });

  it('keeps shared references that are not circular', () => {
    const shared = { id: 1 };
    expect(sanitize({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });

  it('describes binary data', () => {
    expect(sanitize(Buffer.alloc(2048))).toBe('[binário 2048 bytes]');
    expect(sanitize(new Uint8Array(3))).toBe('[binário 3 bytes]');
  });

  it('limits depth', () => {
    expect(sanitize({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } })).toEqual({ a: { b: { c: { d: { e: { f: '[profundidade]' } } } } } });
  });

  it('limits arrays', () => {
    const result = sanitize(Array.from({ length: 60 }, (_, index) => index)) as unknown[];
    expect(result).toHaveLength(51);
    expect(result[50]).toBe('…[mais 10]');
  });

  it('converts dates, bigints, maps, sets and errors and drops functions', () => {
    expect(
      sanitize({
        at: new Date('2026-10-08T12:00:00.000Z'),
        big: 10n,
        map: new Map([['a', 1]]),
        set: new Set(['x']),
        err: new TypeError('x'),
        fn: () => 1,
        nan: Number.NaN,
      }),
    ).toEqual({
      at: '2026-10-08T12:00:00.000Z',
      big: '10',
      map: { a: 1 },
      set: ['x'],
      err: { name: 'TypeError', message: 'x' },
      nan: 'NaN',
    });
  });
});

describe('limitBytes', () => {
  it('keeps values under the limit', () => {
    expect(limitBytes({ a: 1 }, 100)).toEqual({ a: 1 });
  });

  it('replaces oversized values with a truncated preview', () => {
    const result = limitBytes({ text: 'x'.repeat(100) }, 50) as { _truncated: string };
    expect(result._truncated.endsWith(TRUNCATED)).toBe(true);
    expect(result._truncated.length).toBe(50 + TRUNCATED.length);
  });
});

describe('prepareAttrs', () => {
  it('wraps non-object data', () => {
    expect(prepareAttrs('hello', 'mask')).toEqual({ value: 'hello' });
  });

  it('masks sensitive keys and keeps the rest', () => {
    const result = prepareAttrs({ password: 'super-secret-password', storeId: 7 }, 'mask');
    expect(result.storeId).toBe(7);
    expect(result.password).toMatch(/^supe…word #[0-9a-f]{8}$/);
  });

  it('caps the serialized size at 16 KB', () => {
    const result = prepareAttrs({ items: Array.from({ length: 40 }, () => 'x'.repeat(1000)) }, 'mask');
    expect(result).toHaveProperty('_truncated');
  });
});

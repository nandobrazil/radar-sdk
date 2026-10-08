import { describe, expect, it } from 'vitest';
import { requestInfo } from '../src/request.js';
import { sanitize } from '../src/serialize.js';

function elapsed(action: () => unknown): number {
  const started = performance.now();
  action();
  return performance.now() - started;
}

describe('adversarial payloads', () => {
  it('masks backtracking-prone values in linear time', () => {
    const body = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`password${index}`, `Bearer${' '.repeat(1990)}\n\n`]));
    const took = elapsed(() => requestInfo({ method: 'POST', url: '/webhook', headers: {}, body }, 'mask'));
    expect(took).toBeLessThan(150);
  });

  it('stops walking huge objects early', () => {
    const body = Object.fromEntries(Array.from({ length: 200_000 }, (_, index) => [`k${index}`, index]));
    const baseline = elapsed(() => JSON.stringify(body));
    const took = elapsed(() => requestInfo({ method: 'POST', url: '/webhook', headers: {}, body }, 'mask'));
    expect(took / baseline).toBeLessThan(2);
  });

  it('treats every typed array view as binary', () => {
    expect(sanitize(new Float64Array(4))).toBe('[binário 32 bytes]');
    expect(sanitize(new DataView(new ArrayBuffer(6)))).toBe('[binário 6 bytes]');
  });
});

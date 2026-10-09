import { describe, expect, it } from 'vitest';
import { exceptionInfo, isInApp, parseBrowserStack, parseStack } from '../src/stack.js';

const STACK = [
  'TypeError: boom',
  '    at DietService.saveMeal (/app/apps/api/dist/modules/diet/diet.service.js:88:13)',
  '    at async Promise.all (index 0)',
  '    at /app/apps/api/dist/main.js:10:5',
  '    at Module.explode (file:///app/apps/api/dist/esm.js:3:11)',
  '    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
].join('\n');

describe('parseStack', () => {
  it('parses V8 frames', () => {
    expect(parseStack(STACK)).toEqual([
      { fn: 'DietService.saveMeal', file: '/app/apps/api/dist/modules/diet/diet.service.js', line: 88, col: 13, inApp: true },
      { fn: 'Promise.all', file: 'index 0', inApp: false },
      { file: '/app/apps/api/dist/main.js', line: 10, col: 5, inApp: true },
      { fn: 'Module.explode', file: '/app/apps/api/dist/esm.js', line: 3, col: 11, inApp: true },
      { fn: 'Layer.handle', file: '/app/node_modules/express/lib/router/layer.js', line: 95, col: 5, inApp: false },
      { fn: 'process.processTicksAndRejections', file: 'node:internal/process/task_queues', line: 105, col: 5, inApp: false },
    ]);
  });

  it('keeps at most 50 frames', () => {
    const stack = ['Error: x', ...Array.from({ length: 80 }, (_, index) => `    at f${index} (/app/a.js:${index + 1}:1)`)].join('\n');
    expect(parseStack(stack)).toHaveLength(50);
  });

  it('returns an empty list without a stack', () => {
    expect(parseStack(undefined)).toEqual([]);
  });
});

describe('isInApp', () => {
  it('accepts windows paths', () => expect(isInApp('C:\\app\\dist\\main.js')).toBe(true));
  it('rejects node_modules and internals', () => {
    expect(isInApp('C:\\app\\node_modules\\x\\index.js')).toBe(false);
    expect(isInApp('node:events')).toBe(false);
  });
});

describe('exceptionInfo', () => {
  it('uses the subclass name', () => {
    class OlxError extends Error {}
    expect(exceptionInfo(new OlxError('x')).type).toBe('OlxError');
  });

  it('follows the cause chain up to five levels', () => {
    let error = new Error('level 0');
    for (let level = 1; level <= 7; level++) error = new Error(`level ${level}`, { cause: error });
    let info = exceptionInfo(error);
    let depth = 0;
    while (info.cause) {
      info = info.cause;
      depth++;
    }
    expect(depth).toBe(5);
  });

  it('handles thrown strings and plain objects', () => {
    expect(exceptionInfo('falhou')).toEqual({ type: 'Error', message: 'falhou', frames: [] });
    expect(exceptionInfo({ name: 'AxiosError', message: 'timeout' })).toEqual({ type: 'AxiosError', message: 'timeout', frames: [] });
  });
});

describe('parseBrowserStack', () => {
  it('reads Chrome stacks with URLs', () => {
    const stack = [
      'TypeError: Cannot read properties of null',
      '    at handleClick (https://arvorede.link/_app/immutable/nodes/2.Bx1.js:1:2345)',
      '    at https://arvorede.link/_app/immutable/chunks/entry.js:3:10',
      '    at <anonymous>',
    ].join('\n');
    expect(parseBrowserStack(stack)).toEqual([
      { fn: 'handleClick', file: 'https://arvorede.link/_app/immutable/nodes/2.Bx1.js', line: 1, col: 2345, inApp: false },
      { file: 'https://arvorede.link/_app/immutable/chunks/entry.js', line: 3, col: 10, inApp: false },
      { file: '<anonymous>', inApp: false },
    ]);
  });

  it('reads Firefox and Safari stacks', () => {
    const stack = [
      'handleClick@https://arvorede.link/_app/immutable/nodes/2.Bx1.js:1:2345',
      '@https://arvorede.link/_app/immutable/chunks/entry.js:3:10',
      'global code@https://arvorede.link/:12:3',
      '[native code]',
    ].join('\n');
    expect(parseBrowserStack(stack)).toEqual([
      { fn: 'handleClick', file: 'https://arvorede.link/_app/immutable/nodes/2.Bx1.js', line: 1, col: 2345, inApp: false },
      { file: 'https://arvorede.link/_app/immutable/chunks/entry.js', line: 3, col: 10, inApp: false },
      { fn: 'global code', file: 'https://arvorede.link/', line: 12, col: 3, inApp: false },
    ]);
  });

  it('caps the number of frames and ignores junk', () => {
    const stack = Array.from({ length: 80 }, (_, index) => `f${index}@https://a.test/x.js:${index + 1}:1`).join('\n');
    expect(parseBrowserStack(stack)).toHaveLength(50);
    expect(parseBrowserStack(undefined)).toEqual([]);
    expect(parseBrowserStack('just a message')).toEqual([]);
  });
});

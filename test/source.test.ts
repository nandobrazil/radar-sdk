import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExceptionInfo } from '../src/protocol/index.js';
import { clearSourceCache, enrichException, enrichFrames } from '../src/source.js';
import { parseStack } from '../src/stack.js';

const SOURCE = [
  'type Payload = { id: string };',
  '',
  'export function explode(payload: Payload): never {',
  '  const value = payload.id.length;',
  '  throw new Error(`boom ${value}`);',
  '}',
  '',
].join('\n');

let root: string;

type FixtureOptions = { inlineSources: boolean; keepSource: boolean; inlineMap?: boolean };

function compile(name: string, options: FixtureOptions): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  if (options.keepSource) writeFileSync(join(dir, 'src', 'thrower.ts'), SOURCE);
  const output = ts.transpileModule(SOURCE, {
    fileName: 'thrower.ts',
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, sourceMap: true, inlineSources: true },
  });
  const map = JSON.parse(output.sourceMapText ?? '{}') as { sources: string[]; sourcesContent?: string[] };
  map.sources = ['../src/thrower.ts'];
  if (!options.inlineSources) delete map.sourcesContent;
  const code = output.outputText.replace(/\/\/# sourceMappingURL=.*$/m, '').trimEnd();
  const reference = options.inlineMap ? `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}` : 'thrower.js.map';
  writeFileSync(join(dir, 'dist', 'thrower.js'), `${code}\n//# sourceMappingURL=${reference}\n`);
  if (!options.inlineMap) writeFileSync(join(dir, 'dist', 'thrower.js.map'), JSON.stringify(map));
  return join(dir, 'dist', 'thrower.js');
}

function stackOf(file: string): string {
  const script = `try { require(${JSON.stringify(file)}).explode({ id: 'abc' }) } catch (error) { process.stdout.write(error.stack) }`;
  return execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'radar-source-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  clearSourceCache();
});

describe('enrichFrames', () => {
  it('maps to the TypeScript source and reads context from sourcesContent', async () => {
    const file = compile('inline-sources', { inlineSources: true, keepSource: false });
    const [top] = await enrichFrames(parseStack(stackOf(file)), root);
    expect(top!.file).toBe('inline-sources/src/thrower.ts');
    expect(top!.line).toBe(5);
    expect(top!.context).toEqual({
      pre: ['type Payload = { id: string };', '', 'export function explode(payload: Payload): never {', '  const value = payload.id.length;'],
      line: '  throw new Error(`boom ${value}`);',
      post: ['}', ''],
    });
  });

  it('reads the original file from disk when the map has no sourcesContent', async () => {
    const file = compile('disk-source', { inlineSources: false, keepSource: true });
    const [top] = await enrichFrames(parseStack(stackOf(file)), root);
    expect(top!.file).toBe('disk-source/src/thrower.ts');
    expect(top!.context?.line).toContain('throw new Error');
  });

  it('supports inline data URL source maps', async () => {
    const file = compile('inline-map', { inlineSources: true, keepSource: false, inlineMap: true });
    const [top] = await enrichFrames(parseStack(stackOf(file)), root);
    expect(top!.file).toBe('inline-map/src/thrower.ts');
    expect(top!.line).toBe(5);
  });

  it('maps the frame but skips context when no source text exists', async () => {
    const file = compile('no-source', { inlineSources: false, keepSource: false });
    const [top] = await enrichFrames(parseStack(stackOf(file)), root);
    expect(top!.file).toBe('no-source/src/thrower.ts');
    expect(top!.context).toBeUndefined();
  });

  it('adds context to at most ten in-app frames', async () => {
    const file = compile('many', { inlineSources: true, keepSource: false });
    const [frame] = parseStack(stackOf(file));
    const result = await enrichFrames(Array.from({ length: 12 }, () => frame!), root);
    expect(result.filter((item) => item.context)).toHaveLength(10);
  });

  it('never throws for unreadable files', async () => {
    const result = await enrichFrames([{ fn: 'x', file: '/does/not/exist.js', line: 1, col: 1, inApp: true }], '/');
    expect(result).toEqual([{ fn: 'x', file: 'does/not/exist.js', line: 1, col: 1, inApp: true }]);
  });
});

describe('enrichException', () => {
  it('enriches the cause chain', async () => {
    const file = compile('cause', { inlineSources: true, keepSource: false });
    const exception: ExceptionInfo = {
      type: 'Error',
      message: 'outer',
      frames: [],
      cause: { type: 'Error', message: 'boom 3', frames: parseStack(stackOf(file)) },
    };
    const enriched = await enrichException(exception, root);
    expect(enriched.cause?.frames[0]?.file).toBe('cause/src/thrower.ts');
  });
});

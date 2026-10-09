import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { clearSourceCache, enrichFrames } from '../src/source.js';
import { composeServerSourceMaps } from '../src/sveltekit/sourcemaps.js';

const SOURCE = ['type Order = { id: string };', '', 'export function charge(order: Order): never {', '  const amount = order.id.length;', '  throw new Error(`declined ${amount}`);', '}', ''].join('\n');
const MAPPING_COMMENT = /\/\/# sourceMappingURL=.*$/m;
const temporary: string[] = [];

afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporary.push(directory);
  return directory;
}

function transpile(code: string, fileName: string) {
  const output = ts.transpileModule(code, { fileName, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, sourceMap: true, inlineSources: true, allowJs: true } });
  return { code: output.outputText.replace(MAPPING_COMMENT, '').trimEnd(), map: JSON.parse(output.sourceMapText ?? '{}') as { sources: string[]; sourcesContent?: string[]; mappings: string } };
}

function sveltekitBuild() {
  const project = scratch('radar-compose-');
  const generated = join(project, '.svelte-kit/output/server/chunks');
  const served = join(project, 'build/server/chunks/chunks');
  mkdirSync(generated, { recursive: true });
  mkdirSync(served, { recursive: true });
  const first = transpile(SOURCE, 'payments.ts');
  writeFileSync(join(generated, 'payments.js'), `${first.code}\n`);
  writeFileSync(join(generated, 'payments.js.map'), JSON.stringify({ ...first.map, sources: ['../../../../src/lib/server/payments.ts'] }));
  const second = transpile(first.code, 'payments.js');
  const bundled = `import 'node:fs';\nimport 'node:path';\n${second.code}\n`;
  writeFileSync(join(served, 'payments.js-AbC123.js'), bundled);
  writeFileSync(join(served, 'payments.js-AbC123.js.map'), JSON.stringify({ version: 3, sources: ['../../../../.svelte-kit/output/server/chunks/payments.js'], names: [], mappings: `;;${second.map.mappings}` }));
  const lines = bundled.split('\n');
  const line = lines.findIndex((text) => text.includes('throw new Error'));
  return { project, served, bundledFile: join(served, 'payments.js-AbC123.js'), mapFile: join(served, 'payments.js-AbC123.js.map'), throwLine: line + 1, throwCol: (lines[line] ?? '').indexOf('throw') + 1 };
}

describe('composeServerSourceMaps', () => {
  it('rewrites adapter-node server maps to point at the original sources', () => {
    const build = sveltekitBuild();
    expect(composeServerSourceMaps(join(build.project, 'build'))).toBe(1);
    const composed = JSON.parse(readFileSync(build.mapFile, 'utf8')) as { sources: string[]; sourcesContent: string[] };
    expect(composed.sources.map((source) => resolve(build.served, source))).toEqual([join(build.project, 'src/lib/server/payments.ts')]);
    expect(composed.sourcesContent).toEqual([SOURCE]);
  });

  it('lets a server frame resolve to the TypeScript line with its code', async () => {
    const build = sveltekitBuild();
    composeServerSourceMaps(join(build.project, 'build'));
    clearSourceCache();
    const [frame] = await enrichFrames([{ fn: 'charge', file: build.bundledFile, line: build.throwLine, col: build.throwCol, inApp: true }], build.project);
    expect(frame).toMatchObject({ file: 'src/lib/server/payments.ts', line: 5 });
    expect(frame?.context?.line).toContain('throw new Error');
  });

  it('is a no-op on maps that were already composed', () => {
    const build = sveltekitBuild();
    composeServerSourceMaps(join(build.project, 'build'));
    const once = readFileSync(build.mapFile, 'utf8');
    expect(composeServerSourceMaps(join(build.project, 'build'))).toBe(0);
    expect(readFileSync(build.mapFile, 'utf8')).toBe(once);
  });

  it('leaves maps alone when there is no SvelteKit server output to compose with', () => {
    const build = scratch('radar-compose-none-');
    mkdirSync(join(build, 'server'), { recursive: true });
    const map = JSON.stringify({ version: 3, sources: ['../src/a.ts'], names: [], mappings: 'AAAA' });
    writeFileSync(join(build, 'server/a.js.map'), map);
    expect(composeServerSourceMaps(build)).toBe(0);
    expect(composeServerSourceMaps(join(build, 'missing'))).toBe(0);
    expect(readFileSync(join(build, 'server/a.js.map'), 'utf8')).toBe(map);
  });
});

describe('source map mappings', () => {
  it('decode relative and negative values and encode them back unchanged', async () => {
    const { decodeMappings, encodeMappings } = await import('../src/sveltekit/vlq.js');
    expect(decodeMappings('AAgBD,EAAE;;CAAC')).toEqual([[[0, 0, 16, -1], [2, 0, 16, 1]], [], [[1, 0, 16, 2]]]);
    const real = transpile(SOURCE, 'payments.ts').map.mappings;
    expect(encodeMappings(decodeMappings(real))).toBe(real);
    expect(encodeMappings(decodeMappings('A,gggggB'))).toBe('A,gggggB');
  });
});

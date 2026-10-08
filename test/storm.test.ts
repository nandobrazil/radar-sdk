import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RadarClient } from '../src/client.js';

let root: string;
let stack: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'radar-storm-')));
  mkdirSync(join(root, 'dist'));
  const filler = Array.from({ length: 3000 }, (_, index) => `export const value${index} = ${index};`).join('\n');
  const source = `${filler}\nexport function explode(depth: number): never {\n  if (depth > 0) return explode(depth - 1);\n  throw new Error('storm');\n}\n`;
  const output = ts.transpileModule(source, {
    fileName: 'service.ts',
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, sourceMap: true, inlineSources: true },
  });
  const map = JSON.parse(output.sourceMapText ?? '{}') as { sources: string[] };
  map.sources = ['../src/service.ts'];
  writeFileSync(join(root, 'dist', 'service.js'), `${output.outputText.replace(/\/\/# sourceMappingURL=.*$/m, '').trimEnd()}\n//# sourceMappingURL=service.js.map\n`);
  writeFileSync(join(root, 'dist', 'service.js.map'), JSON.stringify(map));
  const script = `try { require(${JSON.stringify(join(root, 'dist', 'service.js'))}).explode(30) } catch (error) { process.stdout.write(error.stack) }`;
  stack = execFileSync(process.execPath, ['--stack-trace-limit=50', '-e', script], { encoding: 'utf8' });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('error storm while Radar is unreachable', () => {
  it('does not spend CPU enriching errors that the full queue will drop', async () => {
    const client = new RadarClient();
    client.init({ key: 'rk_test', endpoint: 'http://127.0.0.1:9', captureUnhandled: false });
    for (let index = 0; index < 1100; index++) client.info('filler', { index });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = process.cpuUsage();
    for (let index = 0; index < 500; index++) {
      const error = new Error('storm');
      error.stack = stack;
      client.captureError(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const used = process.cpuUsage(before);
    await client.close(100);
    expect((used.user + used.system) / 1000).toBeLessThan(200);
  });
});

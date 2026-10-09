import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
});

describe('package output', () => {
  it('emits ESM, CJS and types for every entry', () => {
    const entries = ['index', 'nest/index', 'protocol/index', 'sveltekit/index', 'browser/index'];
    for (const file of entries.flatMap((entry) => ['js', 'cjs', 'd.ts', 'd.cts'].map((extension) => `${entry}.${extension}`))) {
      expect(existsSync(join(root, 'dist', file)), file).toBe(true);
    }
  });

  it('shares one radar client between the ESM and CJS builds', () => {
    const script = `
      const cjs = require(${JSON.stringify(join(root, 'dist/index.cjs'))});
      const protocol = require(${JSON.stringify(join(root, 'dist/protocol/index.cjs'))});
      const nest = require(${JSON.stringify(join(root, 'dist/nest/index.cjs'))});
      import(${JSON.stringify(join(root, 'dist/index.js'))}).then((esm) => {
        process.stdout.write(JSON.stringify({ same: esm.radar === cjs.radar, protocol: protocol.PROTOCOL_VERSION, nest: typeof nest.RadarModule }));
      });
    `;
    const output = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' })) as unknown;
    expect(output).toEqual({ same: true, protocol: 1, nest: 'function' });
  });

  it('embeds the package version', () => {
    const script = `const { radar } = require(${JSON.stringify(join(root, 'dist/index.cjs'))}); process.stdout.write(typeof radar.init);`;
    expect(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })).toBe('function');
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const built = execFileSync('grep', ['-c', version, join(root, 'dist/index.cjs')], { encoding: 'utf8' });
    expect(Number(built.trim())).toBeGreaterThan(0);
  });

  it('ships a browser entry without Node.js imports', () => {
    for (const file of ['browser/index.js', 'browser/index.cjs']) {
      const code = readFileSync(join(root, 'dist', file), 'utf8');
      expect(code, file).not.toMatch(/node:|require\(["'](?:fs|path|url|crypto|os|async_hooks)["']\)|from ["'](?:fs|path|url|crypto|os|async_hooks)["']/);
    }
    const script = `import(${JSON.stringify(join(root, 'dist/browser/index.js'))}).then((m) => { m.reportClientError(new Error('x')); process.stdout.write(typeof m.handleErrorWithRadar); })`;
    expect(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })).toBe('function');
  });

  it('exposes the sveltekit entry and the radar-sourcemaps command', () => {
    const script = `const kit = require(${JSON.stringify(join(root, 'dist/sveltekit/index.cjs'))}); process.stdout.write([typeof kit.radarHandle, typeof kit.radarHandleError, typeof kit.radarClientErrors, typeof kit.moveClientSourceMaps].join(','));`;
    expect(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })).toBe('function,function,function,function');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { bin: Record<string, string> };
    const bin = join(root, pkg.bin['radar-sourcemaps']!);
    const build = mkdtempSync(join(tmpdir(), 'radar-bin-'));
    mkdirSync(join(build, 'client/_app'), { recursive: true });
    writeFileSync(join(build, 'client/_app/a.js.map'), '{}');
    const output = execFileSync(process.execPath, [bin, build], { encoding: 'utf8' });
    expect(output).toContain('1');
    expect(readdirSync(join(build, 'client-maps/_app'))).toEqual(['a.js.map']);
    rmSync(build, { recursive: true, force: true });
  });
});

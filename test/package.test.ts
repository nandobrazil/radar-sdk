import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
});

describe('package output', () => {
  it('emits ESM, CJS and types for every entry', () => {
    for (const file of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts', 'nest/index.js', 'nest/index.cjs', 'nest/index.d.ts', 'nest/index.d.cts', 'protocol/index.js', 'protocol/index.cjs', 'protocol/index.d.ts', 'protocol/index.d.cts']) {
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
    const built = execFileSync('grep', ['-c', '0.1.0', join(root, 'dist/index.cjs')], { encoding: 'utf8' });
    expect(Number(built.trim())).toBeGreaterThan(0);
  });
});

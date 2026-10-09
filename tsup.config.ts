import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

const dts = { compilerOptions: { ignoreDeprecations: '6.0' } };

export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'nest/index': 'src/nest/index.ts', 'protocol/index': 'src/protocol/index.ts', 'sveltekit/index': 'src/sveltekit/index.ts' },
    format: ['esm', 'cjs'],
    dts,
    sourcemap: true,
    target: 'node20',
    platform: 'node',
    shims: true,
    splitting: false,
    external: ['@nestjs/common', '@nestjs/core', 'rxjs', '@sveltejs/kit'],
    define: { __SDK_VERSION__: JSON.stringify(version) },
  },
  {
    entry: { 'browser/index': 'src/browser/index.ts' },
    format: ['esm', 'cjs'],
    dts,
    sourcemap: true,
    target: 'es2020',
    platform: 'browser',
    splitting: false,
  },
  {
    entry: { 'bin/radar-sourcemaps': 'src/bin/radar-sourcemaps.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    splitting: false,
  },
]);

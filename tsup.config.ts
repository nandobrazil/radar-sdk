import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig({
  entry: { index: 'src/index.ts', 'nest/index': 'src/nest/index.ts', 'protocol/index': 'src/protocol/index.ts' },
  format: ['esm', 'cjs'],
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  clean: true,
  sourcemap: true,
  target: 'node20',
  platform: 'node',
  shims: true,
  splitting: false,
  external: ['@nestjs/common', '@nestjs/core', 'rxjs'],
  define: { __SDK_VERSION__: JSON.stringify(version) },
});

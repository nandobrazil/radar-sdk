#!/usr/bin/env node
import { moveClientSourceMaps } from '../sveltekit/sourcemaps.js';

const buildDir = process.argv[2] ?? 'build';
const moved = moveClientSourceMaps(buildDir);
if (moved < 0) {
  process.stderr.write(`radar: ${buildDir}/client not found; run it after vite build\n`);
  process.exit(1);
}
process.stdout.write(`radar: ${moved} source maps moved from ${buildDir}/client to ${buildDir}/client-maps\n`);

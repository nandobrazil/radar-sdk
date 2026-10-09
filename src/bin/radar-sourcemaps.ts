#!/usr/bin/env node
import { composeServerSourceMaps, moveClientSourceMaps } from '../sveltekit/sourcemaps.js';

const buildDir = process.argv[2] ?? 'build';
const moved = moveClientSourceMaps(buildDir);
if (moved < 0) {
  process.stderr.write(`radar: ${buildDir}/client not found; run it after vite build\n`);
  process.exit(1);
}
process.stdout.write(`radar: ${moved} source maps moved from ${buildDir}/client to ${buildDir}/client-maps\n`);
const composed = composeServerSourceMaps(buildDir);
process.stdout.write(`radar: ${composed} server source maps in ${buildDir}/server now point to the original sources\n`);

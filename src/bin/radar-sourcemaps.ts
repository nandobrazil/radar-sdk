#!/usr/bin/env node
import { moveClientSourceMaps } from '../sveltekit/sourcemaps.js';

const buildDir = process.argv[2] ?? 'build';
const moved = moveClientSourceMaps(buildDir);
process.stdout.write(`radar: ${moved} source maps moved from ${buildDir}/client to ${buildDir}/client-maps\n`);

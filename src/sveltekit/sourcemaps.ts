import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

type SourceMapFile = { sources?: unknown; sourceRoot?: unknown };

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.isFile() ? [full] : [];
  });
}

function rebase(source: unknown, fromDir: string, root: string, toDir: string): unknown {
  if (typeof source !== 'string' || isAbsolute(source) || source.includes('://')) return source;
  return relative(toDir, resolve(fromDir, root, source)).split(sep).join('/');
}

function moveMap(file: string, target: string, originalDir: string): void {
  try {
    const map = JSON.parse(readFileSync(file, 'utf8')) as SourceMapFile;
    if (Array.isArray(map.sources)) {
      const root = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
      map.sources = map.sources.map((source) => rebase(source, originalDir, root, dirname(target)));
      delete map.sourceRoot;
    }
    writeFileSync(target, JSON.stringify(map));
    unlinkSync(file);
  } catch {
    renameSync(file, target);
  }
}

export function moveClientSourceMaps(buildDir = 'build'): number {
  const clientDir = resolve(buildDir, 'client');
  const mapsDir = resolve(buildDir, 'client-maps');
  const generatedDir = resolve(buildDir, '..', '.svelte-kit/output/client');
  if (!existsSync(clientDir)) return -1;
  let moved = 0;
  for (const file of filesUnder(clientDir)) {
    if (file.endsWith('.map.gz') || file.endsWith('.map.br')) {
      unlinkSync(file);
      continue;
    }
    if (!file.endsWith('.map')) continue;
    const path = relative(clientDir, file);
    const target = join(mapsDir, path);
    mkdirSync(dirname(target), { recursive: true });
    const generated = join(generatedDir, path);
    moveMap(file, target, dirname(existsSync(generated) ? generated : file));
    moved += 1;
  }
  return moved;
}

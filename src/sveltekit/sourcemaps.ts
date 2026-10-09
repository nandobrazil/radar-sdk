import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.isFile() ? [full] : [];
  });
}

export function moveClientSourceMaps(buildDir = 'build'): number {
  const clientDir = resolve(buildDir, 'client');
  const mapsDir = resolve(buildDir, 'client-maps');
  if (!existsSync(clientDir)) return 0;
  let moved = 0;
  for (const file of filesUnder(clientDir)) {
    if (file.endsWith('.map.gz') || file.endsWith('.map.br')) {
      unlinkSync(file);
      continue;
    }
    if (!file.endsWith('.map')) continue;
    const target = join(mapsDir, relative(clientDir, file));
    mkdirSync(dirname(target), { recursive: true });
    renameSync(file, target);
    moved += 1;
  }
  return moved;
}

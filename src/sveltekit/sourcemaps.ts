import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { decodeMappings, encodeMappings, type Segment } from './vlq.js';

type SourceMapFile = { sources?: unknown; sourceRoot?: unknown };
type RawSourceMap = Record<string, unknown> & { sources?: unknown; sourcesContent?: unknown; names?: unknown; mappings?: unknown; sourceRoot?: unknown };
type ParsedSourceMap = { raw: RawSourceMap; lines: Segment[][]; sources: string[]; contents: (string | null)[]; names: string[]; baseDir: string };

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

function parseSourceMap(file: string): ParsedSourceMap | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as RawSourceMap;
    if (typeof raw.mappings !== 'string' || !Array.isArray(raw.sources)) return null;
    const root = typeof raw.sourceRoot === 'string' ? raw.sourceRoot : '';
    return {
      raw,
      lines: decodeMappings(raw.mappings),
      sources: raw.sources.map((source) => (typeof source === 'string' ? source : '')),
      contents: Array.isArray(raw.sourcesContent) ? raw.sourcesContent.map((content) => (typeof content === 'string' ? content : null)) : [],
      names: Array.isArray(raw.names) ? raw.names.map(String) : [],
      baseDir: resolve(dirname(file), root),
    };
  } catch {
    return null;
  }
}

function isUrl(source: string): boolean {
  return source.includes('://');
}

function isInside(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function traceSegment(map: ParsedSourceMap, line: number, column: number): Segment | null {
  const segments = map.lines[line];
  if (!segments || segments.length === 0) return null;
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((segments[middle]?.[0] ?? 0) <= column) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const segment = segments[Math.max(found, 0)];
  return segment && segment.length >= 4 ? segment : null;
}

class ComposedTable {
  readonly sources: string[] = [];
  readonly contents: (string | null)[] = [];
  readonly names: string[] = [];
  private readonly sourceIndex = new Map<string, number>();
  private readonly nameIndex = new Map<string, number>();

  constructor(private readonly outputDir: string) {}

  source(baseDir: string, source: string, content: string | null): number {
    const key = isUrl(source) || isAbsolute(source) ? source : relative(this.outputDir, resolve(baseDir, source)).split(sep).join('/');
    const existing = this.sourceIndex.get(key);
    if (existing !== undefined) return existing;
    this.sourceIndex.set(key, this.sources.length);
    this.sources.push(key);
    this.contents.push(content);
    return this.sources.length - 1;
  }

  name(value: string): number {
    const existing = this.nameIndex.get(value);
    if (existing !== undefined) return existing;
    this.nameIndex.set(value, this.names.length);
    this.names.push(value);
    return this.names.length - 1;
  }
}

function composeMap(file: string, generatedDir: string, generatedMaps: Map<string, ParsedSourceMap | null>): boolean {
  const outer = parseSourceMap(file);
  if (!outer) return false;
  const inners = outer.sources.map((source) => {
    if (isUrl(source)) return null;
    const path = resolve(outer.baseDir, source);
    if (!isInside(generatedDir, path)) return null;
    if (!generatedMaps.has(path)) generatedMaps.set(path, parseSourceMap(`${path}.map`));
    return generatedMaps.get(path) ?? null;
  });
  if (inners.every((inner) => inner === null)) return false;
  const table = new ComposedTable(dirname(file));
  let traced = 0;
  const lines = outer.lines.map((segments) =>
    segments.map((segment): Segment => {
      const [column = 0, sourceIndex = 0, line = 0, originalColumn = 0, nameIndex] = segment;
      if (segment.length < 4) return [column];
      const inner = inners[sourceIndex];
      const original = inner ? traceSegment(inner, line, originalColumn) : null;
      if (inner && original) {
        traced += 1;
        const [, innerSource = 0, innerLine = 0, innerColumn = 0, innerName] = original;
        const source = table.source(inner.baseDir, inner.sources[innerSource] ?? '', inner.contents[innerSource] ?? null);
        const name = innerName !== undefined ? inner.names[innerName] : nameIndex !== undefined ? outer.names[nameIndex] : undefined;
        return name === undefined ? [column, source, innerLine, innerColumn] : [column, source, innerLine, innerColumn, table.name(name)];
      }
      const source = table.source(outer.baseDir, outer.sources[sourceIndex] ?? '', outer.contents[sourceIndex] ?? null);
      const name = nameIndex !== undefined ? outer.names[nameIndex] : undefined;
      return name === undefined ? [column, source, line, originalColumn] : [column, source, line, originalColumn, table.name(name)];
    }),
  );
  if (traced === 0) return false;
  const { sourceRoot: _root, ignoreList: _ignore, x_google_ignoreList: _googleIgnore, ...rest } = outer.raw;
  const composed = { ...rest, sources: table.sources, sourcesContent: table.contents, names: table.names, mappings: encodeMappings(lines) };
  writeFileSync(file, JSON.stringify(composed));
  return true;
}

export function composeServerSourceMaps(buildDir = 'build'): number {
  const serverDir = resolve(buildDir, 'server');
  const generatedDir = resolve(buildDir, '..', '.svelte-kit/output/server');
  if (!existsSync(serverDir) || !existsSync(generatedDir)) return 0;
  const generatedMaps = new Map<string, ParsedSourceMap | null>();
  let composed = 0;
  for (const file of filesUnder(serverDir)) {
    if (file.endsWith('.map') && composeMap(file, generatedDir, generatedMaps)) composed += 1;
  }
  return composed;
}

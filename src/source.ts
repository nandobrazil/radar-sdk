import { readFile, stat } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, type ExceptionInfo, type StackFrame } from './protocol/index.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_FILES = 50;
const MAPPING_URL = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/;

type LoadedMap = { map: SourceMap; baseDir: string; sources: string[]; contents: (string | null)[]; lines: Map<number, string[]> };
type LoadedFile = { lines: string[]; map: LoadedMap | null };
type MappedFrame = { frame: StackFrame; lines: string[] | null };
type MapPayload = { sources?: string[]; sourcesContent?: (string | null)[]; sourceRoot?: string };
type MapEntry = { originalSource?: string; originalLine?: number; originalColumn?: number };

export type MapLocator = (file: string) => string | null;
export type EnrichOptions = { mapLocator?: MapLocator };

const cache = new Map<string, Promise<LoadedFile | null>>();

export function clearSourceCache(): void {
  cache.clear();
}

export async function enrichFrames(frames: StackFrame[], cwd: string = process.cwd(), options: EnrichOptions = {}): Promise<StackFrame[]> {
  const result: StackFrame[] = [];
  let withContext = 0;
  for (const frame of frames) {
    try {
      const { frame: located, lines } = await mapFrame(frame, options.mapLocator);
      const mapped = located.inApp && isLibraryPath(located.file) ? { ...located, inApp: false } : located;
      let next = mapped;
      if (mapped.inApp && lines && mapped.line && withContext < LIMITS.contextFrames) {
        const context = contextFor(lines, mapped.line);
        if (context) {
          next = { ...mapped, context };
          withContext++;
        }
      }
      result.push({ ...next, file: relativize(next.file, cwd) });
    } catch {
      result.push({ ...frame, file: relativize(frame.file, cwd) });
    }
  }
  return result;
}

export async function enrichException(exception: ExceptionInfo, cwd: string = process.cwd(), options: EnrichOptions = {}): Promise<ExceptionInfo> {
  const frames = await enrichFrames(exception.frames, cwd, options);
  if (!exception.cause) return { ...exception, frames };
  return { ...exception, frames, cause: await enrichException(exception.cause, cwd, options) };
}

function isLibraryPath(file: string): boolean {
  return file.includes('/node_modules/') || file.includes('\\node_modules\\');
}

export function relativize(file: string, cwd: string): string {
  if (!isAbsolute(file)) return file;
  const path = relative(cwd, file);
  return path.startsWith('..') || isAbsolute(path) ? file : path.split(sep).join('/');
}

async function mapFrame(frame: StackFrame, locator?: MapLocator): Promise<MappedFrame> {
  if (!frame.line || !isAbsolute(frame.file)) return { frame, lines: null };
  const file = await loadFile(frame.file, locator);
  if (!file) return { frame, lines: null };
  if (!file.map) return { frame, lines: file.lines };
  const entry = file.map.map.findEntry(frame.line - 1, (frame.col ?? 1) - 1) as MapEntry;
  if (typeof entry.originalSource !== 'string' || typeof entry.originalLine !== 'number') return { frame, lines: file.lines };
  const originalPath = resolveSource(file.map, entry.originalSource);
  const mapped: StackFrame = { ...frame, file: originalPath, line: entry.originalLine + 1, col: (entry.originalColumn ?? 0) + 1 };
  const lines = embeddedLines(file.map, file.map.sources.indexOf(entry.originalSource));
  if (lines) return { frame: mapped, lines };
  const original = await loadFile(originalPath);
  return { frame: mapped, lines: original?.lines ?? null };
}

function embeddedLines(map: LoadedMap, index: number): string[] | null {
  if (index < 0) return null;
  const cached = map.lines.get(index);
  if (cached) return cached;
  const content = map.contents[index];
  if (typeof content !== 'string') return null;
  const lines = content.split(/\r?\n/);
  map.lines.set(index, lines);
  return lines;
}

function contextFor(lines: string[], line: number): StackFrame['context'] {
  const index = line - 1;
  if (index < 0 || index >= lines.length) return undefined;
  const clip = (text: string) => (text.length > LIMITS.contextLineLength ? `${text.slice(0, LIMITS.contextLineLength)}…` : text);
  return {
    pre: lines.slice(Math.max(0, index - LIMITS.contextLines), index).map(clip),
    line: clip(lines[index] ?? ''),
    post: lines.slice(index + 1, index + 1 + LIMITS.contextLines).map(clip),
  };
}

function resolveSource(map: LoadedMap, source: string): string {
  if (source.startsWith('file://')) {
    try {
      return fileURLToPath(source);
    } catch {
      return source;
    }
  }
  return isAbsolute(source) ? source : resolve(map.baseDir, source);
}

function loadFile(path: string, locator?: MapLocator): Promise<LoadedFile | null> {
  const key = locator ? `${path}\u0000located` : path;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const pending = readSource(path, locator).catch(() => null);
  cache.set(key, pending);
  if (cache.size > MAX_CACHED_FILES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return pending;
}

async function readSource(path: string, locator?: MapLocator): Promise<LoadedFile | null> {
  const text = await readText(path);
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  return { lines, map: await loadMap(path, lines, locator) };
}

async function readText(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function loadMap(path: string, lines: string[], locator?: MapLocator): Promise<LoadedMap | null> {
  let url: string | undefined;
  for (let index = lines.length - 1; index >= 0 && index >= lines.length - 5; index--) {
    const match = MAPPING_URL.exec(lines[index] ?? '');
    if (match) {
      url = match[1];
      break;
    }
  }
  let raw: string | null;
  let mapDir: string;
  const located = url ? null : (locator?.(path) ?? `${path}.map`);
  if (located) {
    raw = await readText(located);
    mapDir = dirname(located);
  } else if (!url) {
    return null;
  } else if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const encoded = url.slice(comma + 1);
    raw = url.slice(0, comma).endsWith(';base64') ? Buffer.from(encoded, 'base64').toString('utf8') : decodeURIComponent(encoded);
    mapDir = dirname(path);
  } else {
    const mapPath = url.startsWith('file://') ? fileURLToPath(url) : resolve(dirname(path), decodeURIComponent(url));
    raw = await readText(mapPath);
    mapDir = dirname(mapPath);
  }
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as MapPayload;
    return {
      map: new SourceMap(payload as ConstructorParameters<typeof SourceMap>[0]),
      baseDir: resolve(mapDir, payload.sourceRoot ?? ''),
      sources: payload.sources ?? [],
      contents: payload.sourcesContent ?? [],
      lines: new Map(),
    };
  } catch {
    return null;
  }
}

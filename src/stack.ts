import { fileURLToPath } from 'node:url';
import { LIMITS, type ExceptionInfo, type StackFrame } from './protocol/index.js';
import { truncate } from './serialize.js';

const WITH_FUNCTION = /^at (?:async )?(.+?) \((.+)\)$/;
const LOCATION = /^(.+):(\d+):(\d+)$/;
const AT_SIGN_FRAME = /^(.*?)@(.+):(\d+):(\d+)$/;
const MAX_FRAME_LINE = 1000;

export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (line.length > MAX_FRAME_LINE || !line.startsWith('at ')) continue;
    const withFunction = WITH_FUNCTION.exec(line);
    const fn = withFunction?.[1];
    const location = withFunction ? (withFunction[2] ?? '') : line.replace(/^at (?:async )?/, '');
    const parsed = LOCATION.exec(location);
    if (parsed) {
      const file = toPath(parsed[1] ?? '');
      frames.push({ ...(fn ? { fn } : {}), file, line: Number(parsed[2]), col: Number(parsed[3]), inApp: isInApp(file) });
    } else {
      frames.push({ ...(fn ? { fn } : {}), file: location, inApp: false });
    }
    if (frames.length >= LIMITS.frames) break;
  }
  return frames;
}

export function parseBrowserStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (line.length > MAX_FRAME_LINE) continue;
    if (line.startsWith('at ')) {
      const withFunction = WITH_FUNCTION.exec(line);
      const fn = withFunction?.[1];
      const location = withFunction ? (withFunction[2] ?? '') : line.replace(/^at (?:async )?/, '');
      const parsed = LOCATION.exec(location);
      frames.push(parsed ? { ...(fn ? { fn } : {}), file: parsed[1] ?? '', line: Number(parsed[2]), col: Number(parsed[3]), inApp: false } : { ...(fn ? { fn } : {}), file: location, inApp: false });
    } else {
      const parsed = AT_SIGN_FRAME.exec(line);
      if (!parsed) continue;
      const fn = parsed[1];
      frames.push({ ...(fn ? { fn } : {}), file: parsed[2] ?? '', line: Number(parsed[3]), col: Number(parsed[4]), inApp: false });
    }
    if (frames.length >= LIMITS.frames) break;
  }
  return frames;
}

export function isInApp(file: string): boolean {
  if (file.includes('/node_modules/') || file.includes('\\node_modules\\')) return false;
  if (file.startsWith('node:') || file.startsWith('internal/')) return false;
  return file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file);
}

export function exceptionInfo(error: unknown, depth = 0): ExceptionInfo {
  if (error instanceof Error) {
    const info: ExceptionInfo = {
      type: errorType(error),
      message: truncate(error.message ?? '', LIMITS.messageLength),
      frames: parseStack(error.stack),
    };
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null && depth < LIMITS.causeDepth) info.cause = exceptionInfo(cause, depth + 1);
    return info;
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : safeStringify(error);
    return { type: typeof record.name === 'string' ? record.name : 'Object', message: truncate(message, LIMITS.messageLength), frames: [] };
  }
  return { type: 'Error', message: truncate(String(error), LIMITS.messageLength), frames: [] };
}

function toPath(location: string): string {
  if (!location.startsWith('file://')) return location;
  try {
    return fileURLToPath(location);
  } catch {
    return location;
  }
}

function errorType(error: Error): string {
  if (error.name && error.name !== 'Error') return error.name;
  const constructorName = error.constructor?.name;
  return constructorName && constructorName !== 'Object' ? constructorName : 'Error';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

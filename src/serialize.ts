import type { RedactMode } from './options.js';
import { LIMITS } from './protocol/index.js';
import { redactDeep } from './redact.js';

export const TRUNCATED = '…[cortado]';

export function truncate(value: string, max: number = LIMITS.stringLength): string {
  return value.length > max ? value.slice(0, max) + TRUNCATED : value;
}

export function sanitize(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return truncate(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return undefined;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return `[binário ${value.byteLength} bytes]`;
  if (value instanceof Error) return { name: value.name, message: truncate(value.message) };
  const object = value as object;
  if (seen.has(object)) return '[circular]';
  if (depth >= LIMITS.depth) return '[profundidade]';
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const items = object.slice(0, LIMITS.arrayItems).map((item) => sanitize(item, depth + 1, seen) ?? null);
      if (object.length > LIMITS.arrayItems) items.push(`…[mais ${object.length - LIMITS.arrayItems}]`);
      return items;
    }
    if (object instanceof Map) return sanitize(Object.fromEntries(object.entries()), depth + 1, seen);
    if (object instanceof Set) return sanitize([...object], depth + 1, seen);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      const clean = sanitize(item, depth + 1, seen);
      if (clean !== undefined) result[key] = clean;
    }
    return result;
  } finally {
    seen.delete(object);
  }
}

export function limitBytes(value: unknown, maxBytes: number): unknown {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) <= maxBytes) return value;
  return { _truncated: truncate(json, maxBytes) };
}

export function prepareAttrs(data: unknown, mode: RedactMode): Record<string, unknown> {
  const clean = redactDeep(sanitize(data), mode);
  const record = isRecord(clean) ? clean : { value: clean };
  return limitBytes(record, LIMITS.attrsBytes) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import type { RedactMode } from './options.js';
import { LIMITS } from './protocol/index.js';
import { redactDeep } from './redact.js';

export const TRUNCATED = '…[cortado]';
export const LIMIT_REACHED = '…[limite]';

const MAX_NODES = 2000;

type Budget = { remaining: number };

export function truncate(value: string, max: number = LIMITS.stringLength): string {
  return value.length > max ? value.slice(0, max) + TRUNCATED : value;
}

export function sanitize(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet(), budget: Budget = { remaining: MAX_NODES }): unknown {
  if (value === null || value === undefined) return value;
  budget.remaining -= 1;
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
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[binário ${value.byteLength} bytes]`;
  if (value instanceof Error) return { name: value.name, message: truncate(value.message) };
  const object = value as object;
  if (seen.has(object)) return '[circular]';
  if (depth >= LIMITS.depth) return '[profundidade]';
  if (budget.remaining <= 0) return LIMIT_REACHED;
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const items: unknown[] = [];
      for (const item of object.slice(0, LIMITS.arrayItems)) {
        if (budget.remaining <= 0) {
          items.push(LIMIT_REACHED);
          break;
        }
        items.push(sanitize(item, depth + 1, seen, budget) ?? null);
      }
      if (object.length > LIMITS.arrayItems) items.push(`…[mais ${object.length - LIMITS.arrayItems}]`);
      return items;
    }
    if (object instanceof Map) return sanitize(Object.fromEntries(object.entries()), depth + 1, seen, budget);
    if (object instanceof Set) return sanitize([...object], depth + 1, seen, budget);
    const result: Record<string, unknown> = {};
    for (const key in object) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
      if (budget.remaining <= 0) {
        result['…'] = LIMIT_REACHED;
        break;
      }
      const clean = sanitize((object as Record<string, unknown>)[key], depth + 1, seen, budget);
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

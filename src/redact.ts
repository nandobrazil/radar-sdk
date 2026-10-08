import { createHash } from 'node:crypto';
import type { RedactMode } from './options.js';

const SENSITIVE_KEY = /pass|senha|secret|token|authorization|cookie|api[-_]?key|cpf|card|cvv/i;
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$|^x-.+-(token|key|secret)$/i;
const AUTH_SCHEME = /^(Bearer|Basic|Token|Digest|ApiKey)\s+(.+)$/i;
const MAX_DEPTH = 8;

export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export function maskValue(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const scheme = AUTH_SCHEME.exec(text);
  const prefix = scheme ? `${scheme[1]} ` : '';
  const secret = scheme ? (scheme[2] ?? '') : text;
  const visible = secret.length > 12 ? `${secret.slice(0, 4)}…${secret.slice(-4)}` : '•••';
  return `${prefix}${visible} #${fingerprint(text)}`;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER.test(name);
}

export function redactDeep(value: unknown, mode: RedactMode, depth = 0): unknown {
  if (mode === 'none' || depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, mode, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const hasValue = item !== null && item !== undefined && item !== '';
    result[key] = isSensitiveKey(key) && hasValue ? maskValue(item) : redactDeep(item, mode, depth + 1);
  }
  return result;
}

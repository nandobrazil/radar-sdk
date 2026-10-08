import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { RedactMode } from './options.js';

const SECRET_WORDS = new Set([
  'pass',
  'passwd',
  'password',
  'passwords',
  'senha',
  'secret',
  'secrets',
  'token',
  'tokens',
  'authorization',
  'auth',
  'cookie',
  'cookies',
  'apikey',
  'privatekey',
  'cpf',
  'card',
  'cvv',
  'cvc',
  'pin',
  'otp',
  'signature',
  'jwt',
  'session',
  'sessionid',
  'credential',
  'credentials',
]);
const SECRET_PAIRS = [
  ['api', 'key'],
  ['private', 'key'],
  ['access', 'key'],
  ['secret', 'key'],
];
const LOW_ENTROPY_WORDS = new Set(['pass', 'passwd', 'password', 'passwords', 'senha', 'cpf', 'card', 'cvv', 'cvc', 'pin', 'otp']);
const CUSTOM_SECRET_HEADER = /^x-.+-(key|secret|token)$/i;
const AUTH_SCHEME = /^(Bearer|Basic|Token|Digest|ApiKey)\s+/i;
const JWT_PREFIX = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;
const MAX_DEPTH = 8;
const KEY_SLOT = Symbol.for('@oconde/radar/fingerprint-key');

type FingerprintSlot = { key: Buffer };

function fingerprintSlot(): FingerprintSlot {
  const holder = globalThis as unknown as Record<symbol, FingerprintSlot | undefined>;
  let slot = holder[KEY_SLOT];
  if (!slot) {
    slot = { key: randomBytes(32) };
    holder[KEY_SLOT] = slot;
  }
  return slot;
}

export function setFingerprintSecret(secret: string | undefined): void {
  fingerprintSlot().key = secret ? createHash('sha256').update(`@oconde/radar:${secret}`).digest() : randomBytes(32);
}

export function fingerprint(value: string): string {
  return createHmac('sha256', fingerprintSlot().key).update(value).digest('hex').slice(0, 8);
}

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveKey(key: string): boolean {
  const parts = words(key);
  if (parts.length === 1 && parts[0] === 'key') return true;
  if (parts.some((part) => SECRET_WORDS.has(part))) return true;
  return SECRET_PAIRS.some(([first, second]) => parts.some((part, index) => part === first && parts[index + 1] === second));
}

export function isLowEntropyKey(key: string): boolean {
  return words(key).some((part) => LOW_ENTROPY_WORDS.has(part));
}

export function isSensitiveHeader(name: string): boolean {
  return isSensitiveKey(name) || CUSTOM_SECRET_HEADER.test(name);
}

export function looksLikeCredential(value: string): boolean {
  const head = value.slice(0, 64);
  return AUTH_SCHEME.test(head.slice(0, 16)) || JWT_PREFIX.test(head);
}

export function maskValue(value: unknown, revealEdges = true): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const scheme = AUTH_SCHEME.exec(text.slice(0, 16));
  const prefix = scheme ? `${scheme[1]} ` : '';
  const secret = scheme ? text.slice(scheme[0].length) : text;
  const visible = revealEdges && secret.length > 12 ? `${secret.slice(0, 4)}…${secret.slice(-4)}` : '•••';
  return `${prefix}${visible} #${fingerprint(text)}`;
}

export function redactDeep(value: unknown, mode: RedactMode, depth = 0): unknown {
  if (mode === 'none' || depth > MAX_DEPTH || value === null) return value;
  if (typeof value === 'string') return looksLikeCredential(value) ? maskValue(value) : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, mode, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const hasValue = item !== null && item !== undefined && item !== '';
    result[key] = isSensitiveKey(key) && hasValue ? maskValue(item, !isLowEntropyKey(key)) : redactDeep(item, mode, depth + 1);
  }
  return result;
}

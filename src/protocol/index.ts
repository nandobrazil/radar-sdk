export const PROTOCOL_VERSION = 1;

export const INGEST_PATH = '/api/v1/events';

export const LIMITS = {
  batchBytes: 1_000_000,
  batchEvents: 500,
  messageLength: 2000,
  stringLength: 2000,
  attrsBytes: 16_384,
  bodyBytes: 16_384,
  headers: 50,
  frames: 50,
  contextFrames: 10,
  contextLines: 5,
  contextLineLength: 300,
  causeDepth: 5,
  depth: 6,
  arrayItems: 50,
  requestIdLength: 128,
} as const;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type EventBatch = {
  v: 1;
  sdk: { name: string; version: string };
  environment?: string;
  release?: string;
  dropped?: number;
  events: RadarEvent[];
};

export type RadarEvent = LogEvent | ErrorEvent;

export type LogEvent = {
  type: 'log';
  ts: number;
  level: LogLevel;
  message: string;
  requestId?: string;
  attrs?: Record<string, unknown>;
  request?: RequestInfo;
  user?: UserInfo;
};

export type ErrorEvent = {
  type: 'error';
  ts: number;
  level: 'error' | 'fatal';
  handled: boolean;
  requestId?: string;
  exception: ExceptionInfo;
  request?: RequestInfo;
  user?: UserInfo;
  runtime?: RuntimeInfo;
  attrs?: Record<string, unknown>;
};

export type ExceptionInfo = {
  type: string;
  message: string;
  frames: StackFrame[];
  cause?: ExceptionInfo;
};

export type StackFrame = {
  fn?: string;
  file: string;
  line?: number;
  col?: number;
  inApp: boolean;
  context?: { pre: string[]; line: string; post: string[] };
};

export type RequestInfo = {
  method: string;
  url: string;
  route?: string;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  ip?: string;
  userAgent?: string;
  status?: number;
  durationMs?: number;
};

export type UserInfo = { id?: string; email?: string; name?: string };

export type RuntimeInfo = {
  name: 'node';
  version: string;
  host?: string;
  pid?: number;
  memoryMb?: number;
  uptimeS?: number;
};

export type IngestResponse = { accepted: number; dropped: number };

export type IngestErrorCode =
  | 'invalid_key'
  | 'account_disabled'
  | 'payload_too_large'
  | 'invalid_batch'
  | 'quota_exceeded'
  | 'rate_limited';

export type IngestError = { error: { code: IngestErrorCode; message: string } };

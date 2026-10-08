import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { LIMITS, type EventBatch, type RadarEvent } from './protocol/index.js';
import { describeError } from './util.js';

const gzipAsync = promisify(gzip);

const MAX_BATCH_BYTES = 900_000;
const GZIP_THRESHOLD_BYTES = 8192;
const MAX_BACKOFF_MS = 30_000;
const UNAUTHORIZED_PAUSE_MS = 10 * 60_000;

export type Pending = RadarEvent | (() => Promise<RadarEvent>);

export type TransportConfig = {
  url: string;
  key: string;
  sdk: { name: string; version: string };
  environment: string;
  release?: string;
  onWarning?: (message: string, always: boolean) => void;
  flushIntervalMs?: number;
  maxQueue?: number;
  batchSize?: number;
  requestTimeoutMs?: number;
};

type Outcome =
  | { kind: 'ok' }
  | { kind: 'retry'; retryAfterMs?: number }
  | { kind: 'unauthorized'; status: number }
  | { kind: 'rejected'; status: number };

export class Transport {
  private queue: Pending[] = [];
  private droppedCount = 0;
  private inFlight: Promise<boolean> | null = null;
  private nextAttemptAt = 0;
  private backoffMs = 0;
  private stopped = false;
  private readonly warned = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly maxQueue: number;
  private readonly batchSize: number;

  constructor(private readonly config: TransportConfig) {
    this.maxQueue = config.maxQueue ?? 1000;
    this.batchSize = Math.min(config.batchSize ?? 100, LIMITS.batchEvents);
    this.timer = setInterval(() => {
      void this.send();
    }, config.flushIntervalMs ?? 2000);
    this.timer.unref();
  }

  get pending(): number {
    return this.queue.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  enqueue(event: Pending): void {
    if (this.stopped) return;
    if (this.queue.length >= this.maxQueue) {
      this.droppedCount += 1;
      this.warn('queue_full', 'fila do Radar cheia; eventos estão sendo descartados', false);
      return;
    }
    this.queue.push(event);
    if (this.queue.length >= this.batchSize) void this.send();
  }

  send(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped || this.queue.length === 0 || Date.now() < this.nextAttemptAt) return Promise.resolve(false);
    const attempt = this.sendBatch().catch((error: unknown) => {
      this.warn('internal', `envio ao Radar falhou: ${describeError(error)}`, false);
      return false;
    });
    this.inFlight = attempt.finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async flush(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length > 0 || this.inFlight) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const progressed = await withTimeout(this.send(), remaining);
      if (progressed !== true && !this.inFlight) return;
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private async sendBatch(): Promise<boolean> {
    const items = this.queue.splice(0, this.batchSize);
    const resolved = await Promise.all(items.map((item) => Promise.resolve().then(() => (typeof item === 'function' ? item() : item)).then((event) => event, () => null)));
    const events: RadarEvent[] = [];
    const leftovers: RadarEvent[] = [];
    let bytes = 0;
    for (const event of resolved) {
      if (!event) {
        this.droppedCount += 1;
        continue;
      }
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length > 0 && bytes + size > MAX_BATCH_BYTES) {
        leftovers.push(event);
        continue;
      }
      events.push(event);
      bytes += size;
    }
    if (leftovers.length > 0) this.queue.unshift(...leftovers);
    if (events.length === 0) return true;
    const dropped = this.droppedCount;
    const batch: EventBatch = {
      v: 1,
      sdk: this.config.sdk,
      environment: this.config.environment,
      ...(this.config.release ? { release: this.config.release } : {}),
      ...(dropped > 0 ? { dropped } : {}),
      events,
    };
    const outcome = await this.post(batch);
    switch (outcome.kind) {
      case 'ok':
        this.droppedCount -= dropped;
        this.backoffMs = 0;
        this.nextAttemptAt = 0;
        return true;
      case 'retry':
        this.requeue(events);
        this.backoffMs = Math.min(this.backoffMs > 0 ? this.backoffMs * 2 : 1000, MAX_BACKOFF_MS);
        this.nextAttemptAt = Date.now() + Math.max(this.backoffMs, outcome.retryAfterMs ?? 0);
        return false;
      case 'unauthorized':
        this.droppedCount += events.length + this.queue.length;
        this.queue = [];
        this.nextAttemptAt = Date.now() + UNAUTHORIZED_PAUSE_MS;
        this.warn('unauthorized', `chave do Radar recusada (${outcome.status}); envios pausados por 10 minutos`, true);
        return false;
      case 'rejected':
        this.droppedCount += events.length;
        this.warn(`rejected_${outcome.status}`, `lote recusado pelo Radar (${outcome.status}); eventos descartados`, true);
        return true;
    }
  }

  private requeue(events: RadarEvent[]): void {
    this.queue.unshift(...events);
    const overflow = this.queue.length - this.maxQueue;
    if (overflow > 0) {
      this.queue.splice(this.maxQueue, overflow);
      this.droppedCount += overflow;
    }
  }

  private async post(batch: EventBatch): Promise<Outcome> {
    const json = JSON.stringify(batch);
    const compress = Buffer.byteLength(json) > GZIP_THRESHOLD_BYTES;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.key}`,
      'user-agent': `${this.config.sdk.name}/${this.config.sdk.version}`,
    };
    if (compress) headers['content-encoding'] = 'gzip';
    let response: Response;
    try {
      response = await fetch(this.config.url, {
        method: 'POST',
        headers,
        body: compress ? await gzipAsync(json) : json,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 5000),
      });
    } catch (error) {
      this.warn('network', `Radar indisponível: ${describeError(error)}`, false);
      return { kind: 'retry' };
    }
    await response.arrayBuffer().catch(() => undefined);
    if (response.ok) return { kind: 'ok' };
    if (response.status === 401 || response.status === 403) return { kind: 'unauthorized', status: response.status };
    if (response.status === 429) return { kind: 'retry', retryAfterMs: retryAfterMs(response.headers.get('retry-after')) };
    if (response.status >= 500) return { kind: 'retry' };
    return { kind: 'rejected', status: response.status };
  }

  private warn(key: string, message: string, always: boolean): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.config.onWarning?.(message, always);
  }
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { currentContext, requestIdFrom, runWithContext, type RadarContext, type RequestLike } from './context.js';
import { createMiddleware, type RadarMiddleware } from './express.js';
import { levelEnabled, resolveOptions, type RadarOptions, type RedactMode, type ResolvedOptions } from './options.js';
import { installProcessHandlers } from './process-handlers.js';
import {
  INGEST_PATH,
  LIMITS,
  type ErrorEvent,
  type LogEvent,
  type LogLevel,
  type RadarEvent,
  type RequestInfo,
  type RuntimeInfo,
  type UserInfo,
} from './protocol/index.js';
import { pathParams, redactPath, requestInfo, requestPath, requestRoute } from './request.js';
import { setFingerprintSecret } from './redact.js';
import { prepareAttrs, truncate } from './serialize.js';
import { enrichException } from './source.js';
import { exceptionInfo } from './stack.js';
import { Transport } from './transport.js';
import { describeError, elapsedSince } from './util.js';
import { SDK_NAME, SDK_VERSION } from './version.js';

export type Attributes = Record<string, unknown>;
export type LogRequestOptions = { level?: LogLevel; redact?: RedactMode };

type LogExtras = { request?: RequestInfo; mode?: RedactMode };

export class RadarClient {
  private options: ResolvedOptions = resolveOptions({}, {});
  private transport: Transport | null = null;
  private initialized = false;
  private closed = false;
  private readonly captured = new WeakSet<object>();

  get isEnabled(): boolean {
    return this.transport !== null && !this.closed;
  }

  get settings(): Readonly<ResolvedOptions> {
    return this.options;
  }

  init(options: RadarOptions = {}): void {
    try {
      if (this.initialized) {
        this.debugWarn('radar.init chamado mais de uma vez; mantida a primeira configuração');
        return;
      }
      this.initialized = true;
      this.options = resolveOptions(options);
      setFingerprintSecret(this.options.key);
      if (this.options.enabled && this.options.key) {
        this.transport = new Transport({
          url: this.options.endpoint + INGEST_PATH,
          key: this.options.key,
          sdk: { name: SDK_NAME, version: SDK_VERSION },
          environment: this.options.environment,
          ...(this.options.release ? { release: this.options.release } : {}),
          onWarning: (message, always) => (always ? this.writeWarning(message) : this.debugWarn(message)),
        });
      }
      if (this.options.captureUnhandled && (this.transport || this.options.console)) installProcessHandlers(this);
    } catch (error) {
      this.debugWarn(`radar.init falhou: ${describeError(error)}`);
    }
  }

  debug(message: string, data?: Attributes): void {
    this.safely(() => this.emitLog('debug', message, data));
  }

  info(message: string, data?: Attributes): void {
    this.safely(() => this.emitLog('info', message, data));
  }

  warn(message: string, data?: Attributes): void {
    this.safely(() => this.emitLog('warn', message, data));
  }

  error(message: string, data?: Attributes): void {
    this.safely(() => this.emitLog('error', message, data));
  }

  logRequest(title: string, data?: Attributes, options: LogRequestOptions = {}): void {
    this.safely(() => {
      const context = currentContext();
      const mode = options.redact ?? this.options.redact;
      const request = context?.req ? requestInfo(context.req, mode, { route: context.route }, this.options.requestDetail) : undefined;
      this.emitLog(options.level ?? 'info', title, data, { request, mode });
    });
  }

  captureError(error: unknown, data?: Attributes): void {
    this.safely(() => this.emitError(error, data, 'error', true));
  }

  captureUnhandled(error: unknown, level: 'error' | 'fatal'): void {
    this.safely(() => this.emitError(error, undefined, level, false));
  }

  setUser(user: UserInfo): void {
    this.safely(() => {
      const context = currentContext();
      if (!context) return;
      context.user = {
        ...(user.id !== undefined && user.id !== null ? { id: truncate(String(user.id), 200) } : {}),
        ...(user.email ? { email: truncate(String(user.email), 200) } : {}),
        ...(user.name ? { name: truncate(String(user.name), 200) } : {}),
      };
    });
  }

  async track<T>(name: string, fn: () => T | Promise<T>, data?: Attributes): Promise<T> {
    const execute = async (): Promise<T> => {
      const started = performance.now();
      try {
        const result = await fn();
        this.info(name, { ...data, durationMs: elapsedSince(started), ok: true });
        return result;
      } catch (error) {
        this.error(name, { ...data, durationMs: elapsedSince(started), ok: false });
        this.captureError(error, data);
        throw error;
      }
    };
    if (currentContext()) return execute();
    return runWithContext({ requestId: randomUUID(), startedAt: performance.now() }, execute);
  }

  withContext<T>(fn: () => T, options: { requestId?: string } = {}): T {
    return runWithContext({ requestId: requestIdFrom(options.requestId), startedAt: performance.now() }, fn);
  }

  middleware(): RadarMiddleware {
    return createMiddleware(this);
  }

  shouldLogRequest(req: RequestLike): boolean {
    return this.options.logRequests && !this.options.ignorePaths.includes(requestPath(req));
  }

  logHttpRequest(context: RadarContext, status: number): void {
    this.safely(() => {
      const req = context.req;
      if (!req) return;
      const level: LogLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      const route = requestRoute(req, context.route);
      runWithContext(context, () =>
        this.emitLog(level, 'http.request', {
          method: (req.method ?? 'GET').toUpperCase(),
          ...(route ? { route } : {}),
          ...(this.options.requestDetail === 'full' ? { path: redactPath(requestPath(req), pathParams(req, requestPath(req)), this.options.redact) } : {}),
          status,
          durationMs: elapsedSince(context.startedAt),
        }),
      );
    });
  }

  async flush(timeoutMs = 2000): Promise<void> {
    try {
      await this.transport?.flush(timeoutMs);
    } catch (error) {
      this.debugWarn(`flush falhou: ${describeError(error)}`);
    }
  }

  async close(timeoutMs = 2000): Promise<void> {
    if (this.closed) return;
    await this.flush(timeoutMs);
    this.closed = true;
    this.transport?.stop();
  }

  private emitLog(level: LogLevel, message: string, data: Attributes | undefined, extras: LogExtras = {}): void {
    if (this.closed || !levelEnabled(level, this.options.minLevel)) return;
    const context = currentContext();
    const mode = extras.mode ?? this.options.redact;
    const event: LogEvent = {
      type: 'log',
      ts: Date.now(),
      level,
      message: truncate(String(message), LIMITS.messageLength),
      ...(context ? { requestId: context.requestId } : {}),
      ...(data !== undefined ? { attrs: prepareAttrs(data, mode) } : {}),
      ...(extras.request ? { request: extras.request } : {}),
      ...(context?.user ? { user: context.user } : {}),
    };
    this.print(event);
    this.transport?.enqueue(event);
  }

  private emitError(error: unknown, data: Attributes | undefined, level: 'error' | 'fatal', handled: boolean): void {
    if (this.closed) return;
    if (typeof error === 'object' && error !== null) {
      if (this.captured.has(error)) return;
      this.captured.add(error);
    }
    const context = currentContext();
    const mode = this.options.redact;
    const event: ErrorEvent = {
      type: 'error',
      ts: Date.now(),
      level,
      handled,
      exception: exceptionInfo(error),
      ...(context ? { requestId: context.requestId } : {}),
      ...(context?.req ? { request: requestInfo(context.req, mode, { route: context.route }, this.options.requestDetail) } : {}),
      ...(context?.user ? { user: context.user } : {}),
      runtime: runtimeInfo(),
      ...(data !== undefined ? { attrs: prepareAttrs(data, mode) } : {}),
    };
    this.print(event, error instanceof Error ? error.stack : undefined);
    if (!this.transport) return;
    this.transport.enqueue(() =>
      enrichException(event.exception).then(
        (exception) => ({ ...event, exception }),
        () => event,
      ),
    );
  }

  private print(event: RadarEvent, stack?: string): void {
    if (!this.options.console) return;
    try {
      const requestId = event.requestId ? { requestId: event.requestId } : {};
      if (event.type === 'log') {
        const line = { ...event.attrs, ts: new Date(event.ts).toISOString(), level: event.level, message: event.message, ...requestId };
        (event.level === 'error' ? process.stderr : process.stdout).write(`${JSON.stringify(line)}\n`);
        return;
      }
      const line = {
        ...event.attrs,
        ts: new Date(event.ts).toISOString(),
        level: event.level,
        message: `${event.exception.type}: ${event.exception.message}`,
        ...requestId,
        ...(stack ? { stack } : {}),
      };
      process.stderr.write(`${JSON.stringify(line)}\n`);
    } catch {
      return;
    }
  }

  private safely(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.debugWarn(`falha interna do Radar: ${describeError(error)}`);
    }
  }

  private debugWarn(message: string): void {
    if (this.options.debug) this.writeWarning(message);
  }

  private writeWarning(message: string): void {
    try {
      process.stderr.write(`[radar] ${message}\n`);
    } catch {
      return;
    }
  }
}

function runtimeInfo(): RuntimeInfo {
  return {
    name: 'node',
    version: process.versions.node,
    host: hostname(),
    pid: process.pid,
    memoryMb: Math.round(process.memoryUsage.rss() / 1_048_576),
    uptimeS: Math.round(process.uptime()),
  };
}

export type UnhandledCapturer = {
  captureUnhandled(error: unknown, level: 'error' | 'fatal'): void;
  flush(timeoutMs?: number): Promise<void>;
};

const INSTALLED = Symbol.for('@oconde/radar/process-handlers');

export function installProcessHandlers(capturer: UnhandledCapturer): void {
  const holder = process as unknown as Record<symbol, boolean | undefined>;
  if (holder[INSTALLED]) return;
  holder[INSTALLED] = true;

  process.on('unhandledRejection', (reason) => {
    if (process.listenerCount('unhandledRejection') > 1) {
      capturer.captureUnhandled(reason, 'error');
      return;
    }
    setImmediate(() => {
      throw reason;
    });
  });

  process.on('uncaughtException', (error) => {
    capturer.captureUnhandled(error, 'fatal');
    if (process.listenerCount('uncaughtException') > 1) return;
    void capturer.flush(2000).finally(() => {
      process.stderr.write(`${error instanceof Error && error.stack ? error.stack : String(error)}\n`);
      process.exit(1);
    });
  });
}

import { inspect } from 'node:util';

export type UnhandledCapturer = {
  captureUnhandled(error: unknown, level: 'error' | 'fatal'): void;
  flush(timeoutMs?: number): Promise<void>;
};

const INSTALLED = Symbol.for('@oconde/radar/process-handlers');
const MODE_FLAG = /^--unhandled-rejections=(\S+)$/;

export function unhandledRejectionsMode(execArgv: string[] = process.execArgv, nodeOptions: string = process.env.NODE_OPTIONS ?? ''): string {
  for (const arg of [...nodeOptions.split(/\s+/), ...execArgv]) {
    const match = MODE_FLAG.exec(arg);
    if (match?.[1]) return match[1];
  }
  return 'throw';
}

export function asUncaught(reason: unknown): unknown {
  if (reason instanceof Error) return reason;
  const error = new Error(
    `This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${inspect(reason)}".`,
  ) as Error & { code: string };
  error.code = 'ERR_UNHANDLED_REJECTION';
  return error;
}

export function installProcessHandlers(capturer: UnhandledCapturer): void {
  const holder = process as unknown as Record<symbol, boolean | undefined>;
  if (holder[INSTALLED]) return;
  holder[INSTALLED] = true;

  process.on('unhandledRejection', (reason) => {
    const mode = unhandledRejectionsMode();
    const othersListen = process.listenerCount('unhandledRejection') > 1;
    if (othersListen || mode !== 'throw') {
      capturer.captureUnhandled(reason, 'error');
      if (!othersListen && mode === 'warn-with-error-code') process.exitCode = 1;
      return;
    }
    const uncaught = asUncaught(reason);
    setImmediate(() => {
      throw uncaught;
    });
  });

  process.on('uncaughtException', (error) => {
    capturer.captureUnhandled(error, 'fatal');
    if (process.listenerCount('uncaughtException') > 1) return;
    try {
      process.stderr.write(`${inspect(error)}\n`);
    } catch {
      process.exitCode = 1;
    }
    void capturer.flush(2000).finally(() => process.exit(1));
  });
}

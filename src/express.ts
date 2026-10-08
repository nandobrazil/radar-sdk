import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runWithContext, type RadarContext, type RequestLike, type ResponseLike } from './context.js';
import { LIMITS } from './protocol/index.js';
import { headerValue } from './request.js';

export type RequestLogger = {
  shouldLogRequest(req: RequestLike): boolean;
  logHttpRequest(context: RadarContext, status: number): void;
};

export type RadarMiddleware = (req: RequestLike, res: ResponseLike, next: (error?: unknown) => void) => void;

export function createMiddleware(logger: RequestLogger): RadarMiddleware {
  return (req, res, next) => {
    let context: RadarContext;
    try {
      const incoming = headerValue(req.headers['x-request-id'])?.trim();
      const requestId = incoming && incoming.length <= LIMITS.requestIdLength ? incoming : randomUUID();
      context = { requestId, startedAt: performance.now(), req };
      res.setHeader('x-request-id', requestId);
      if (logger.shouldLogRequest(req)) res.once('finish', () => logger.logHttpRequest(context, res.statusCode));
    } catch {
      next();
      return;
    }
    runWithContext(context, () => next());
  };
}

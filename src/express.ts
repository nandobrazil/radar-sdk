import { performance } from 'node:perf_hooks';
import { requestIdFrom, runWithContext, type RadarContext, type RequestLike, type ResponseLike } from './context.js';
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
      const requestId = requestIdFrom(headerValue(req.headers['x-request-id']));
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

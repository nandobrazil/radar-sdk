import { performance } from 'node:perf_hooks';

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function elapsedSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

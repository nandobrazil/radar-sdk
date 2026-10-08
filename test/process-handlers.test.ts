import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ErrorEvent } from '../src/protocol/index.js';
import { startFakeIngest, type FakeIngest } from './helpers/fake-ingest.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/crash.ts', import.meta.url));

let server: FakeIngest;

beforeEach(async () => {
  server = await startFakeIngest();
});

afterEach(async () => {
  await server.close();
});

function run(mode: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', FIXTURE, mode], { env: { ...process.env, RADAR_ENDPOINT: server.url } }, (error, _stdout, stderr) => {
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stderr });
    });
  });
}

const errors = () => server.events().filter((event): event is ErrorEvent => event.type === 'error');

describe('process handlers', () => {
  it('reports an uncaught exception as fatal and still exits with code 1', async () => {
    const result = await run('throw');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('crash now');
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatchObject({ level: 'fatal', handled: false, exception: { message: 'crash now' } });
  });

  it('crashes on an unhandled rejection when the app has no handler, reporting it once', async () => {
    const result = await run('reject');
    expect(result.code).toBe(1);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatchObject({ level: 'fatal', exception: { message: 'rejected now' } });
  });

  it('only reports the rejection when the app has its own handler', async () => {
    const result = await run('reject-with-listener');
    expect(result.code).toBe(0);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatchObject({ level: 'error', handled: false, exception: { message: 'handled elsewhere' } });
  });
});

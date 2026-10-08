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

function run(mode: string, nodeArgs: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [...nodeArgs, '--import', 'tsx', FIXTURE, mode], { env: { ...process.env, RADAR_ENDPOINT: server.url } }, (error, stdout, stderr) => {
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
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

  it('respects --unhandled-rejections=warn and only reports the rejection', async () => {
    const result = await run('reject-warn', ['--unhandled-rejections=warn']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('still alive');
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatchObject({ level: 'error', handled: false, exception: { message: 'tolerated rejection' } });
  });

  it('installs nothing when the SDK has no key and no console', async () => {
    const result = await run('disabled-reject', ['--unhandled-rejections=warn']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('still alive');
  });

  it('wraps a non-Error rejection like Node does', async () => {
    const result = await run('reject-string');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ERR_UNHANDLED_REJECTION');
    expect(errors()[0]?.exception.message).toContain('plain string reason');
  });
});

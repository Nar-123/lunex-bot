import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { GmgnCliExecutionError, runGmgnCliJson } from '../../src/discovery/cliExec';

const FAST_OPTS = { timeoutMs: 2000, maxRetries: 0, retryBaseDelayMs: 1 };

// runGmgnCliJson uses the REAL execFile -- these tests observe it through a
// mocked child_process module rather than spawning actual binaries.

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const execFileMock = vi.mocked(execFile);

afterEach(() => {
  execFileMock.mockReset();
});

function successfulCall(stdout: string) {
  execFileMock.mockImplementation(
    ((_cmd: string, _args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, stdout);
    }) as typeof execFile,
  );
}

describe('runGmgnCliJson (real execFile, mocked child process)', () => {
  it('returns the parsed stdout as JSON on success', async () => {
    successfulCall('{"code":0,"data":{"rank":[]}}');
    const body = await runGmgnCliJson('gmgn-cli', ['market', 'trending', '--raw'], FAST_OPTS);
    expect(body).toEqual({ code: 0, data: { rank: [] } });
  });

  it('wraps a non-zero CLI exit as GmgnCliExecutionError -- e.g. "unknown option --timeframe"', async () => {
    execFileMock.mockImplementation(
      ((_cmd: string, _args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        // The exact failure mode the old (pre-fix) argv produced against
        // the real CLI: commander rejects unknown options and exits 1.
        cb(Object.assign(new Error("error: unknown option '--timeframe'"), { code: 1 }), '');
      }) as typeof execFile,
    );
    await expect(runGmgnCliJson('gmgn-cli', ['market', 'trending', '--timeframe', '6h'], FAST_OPTS)).rejects.toThrow(
      GmgnCliExecutionError,
    );
  });

  it('wraps non-JSON stdout as GmgnCliExecutionError, never returns undefined', async () => {
    successfulCall('not json at all');
    await expect(runGmgnCliJson('gmgn-cli', ['token', 'info', '--raw'], FAST_OPTS)).rejects.toThrow(
      GmgnCliExecutionError,
    );
  });

  it('wraps a spawn error (CLI not installed) as GmgnCliExecutionError', async () => {
    execFileMock.mockImplementation(
      ((_cmd: string, _args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        cb(new Error('spawn gmgn-cli ENOENT'), '');
      }) as typeof execFile,
    );
    await expect(runGmgnCliJson('gmgn-cli', ['market', 'trending', '--raw'], FAST_OPTS)).rejects.toThrow(
      GmgnCliExecutionError,
    );
  });

  it('carries the offending command and args on the error for diagnosis', async () => {
    execFileMock.mockImplementation(
      ((_cmd: string, _args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        cb(Object.assign(new Error('HTTP 401'), { code: 1 }), '');
      }) as typeof execFile,
    );
    const promise = runGmgnCliJson('gmgn-cli', ['token', 'info', '--raw'], FAST_OPTS);
    await expect(promise).rejects.toThrow(GmgnCliExecutionError);
    // Re-run to capture the concrete error and inspect its fields.
    await expect(
      runGmgnCliJson('gmgn-cli', ['token', 'info', '--raw'], FAST_OPTS),
    ).rejects.toMatchObject({
      command: 'gmgn-cli',
      args: ['token', 'info', '--raw'],
    });
  });
});

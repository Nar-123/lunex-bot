import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChildEnv, CommandRefused, CommandRunner } from '../src/commandRunner';
import { ScopeGuard, ScopeViolation } from '../src/scopeGuard';
import { createMasker, MASK } from '../src/secretMask';

let root: string;
let workspace: string;
let guard: ScopeGuard;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunex-ai-runner-unit-'));
  workspace = path.join(root, 'lunex');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  guard = new ScopeGuard({ workspaceDir: workspace, aiHomeDir: path.join(root, 'ai'), deniedRoots: [path.join(root, 'production')] });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

interface FakeChild {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  close: (code: number | null) => void;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  Object.assign(emitter, { stdout, stderr, kill, pid: undefined });
  return { child: emitter as unknown as ChildProcess, stdout, stderr, kill, close: (code) => { emitter.emit('close', code); } };
}

describe('CommandRunner -- checks happen before anything is spawned', () => {
  it('a command outside the allowlist is refused and never spawned', async () => {
    const spawnImpl = vi.fn();
    const runner = new CommandRunner({ guard, mask: createMasker([]), timeoutMs: 1000, spawnImpl });
    await expect(runner.run({ program: 'git', args: ['push', 'origin', 'main'] })).rejects.toBeInstanceOf(CommandRefused);
    await expect(runner.run({ program: 'node', args: ['dist/validate-live.js'] })).rejects.toBeInstanceOf(CommandRefused);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('an allowed command whose path argument escapes the workspace is refused and never spawned', async () => {
    const spawnImpl = vi.fn();
    const runner = new CommandRunner({ guard, mask: createMasker([]), timeoutMs: 1000, spawnImpl });
    await expect(runner.run({ program: 'git', args: ['add', '../../etc/passwd'] })).rejects.toBeInstanceOf(ScopeViolation);
    await expect(runner.run({ program: 'npx', args: ['vitest', 'run', path.join(root, 'production', 'x.test.ts')] })).rejects.toBeInstanceOf(ScopeViolation);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('runs allowed commands in the workspace, without a shell on git, with a sanitized environment', async () => {
    const fc = fakeChild();
    const spawnImpl = vi.fn(() => fc.child);
    const runner = new CommandRunner({
      guard,
      mask: createMasker([]),
      timeoutMs: 1000,
      spawnImpl,
      parentEnv: { PATH: '/usr/bin', TELEGRAM_BOT_TOKEN: 'x', TOKENROUTER_API_KEY: 'y', PRIVATE_KEY: 'z', DATABASE_URL: 'postgres://prod' },
    });
    const pending = runner.run({ program: 'git', args: ['status'] });
    await vi.waitFor(() => { expect(spawnImpl).toHaveBeenCalled(); });
    fc.stdout.write('On branch ai/develop\n');
    fc.close(0);
    const result = await pending;

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, command: 'git status' });
    expect(result.stdout).toContain('On branch ai/develop');
    const [program, args, options] = spawnImpl.mock.calls[0] as unknown as [string, string[], { cwd: string; env: NodeJS.ProcessEnv; shell: boolean }];
    expect(program).toBe('git');
    expect(args).toEqual(['status']);
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(guard.workspaceDir);
    expect(options.env).toMatchObject({ PATH: '/usr/bin', NODE_ENV: 'test', CI: '1', GIT_TERMINAL_PROMPT: '0' });
    for (const secret of ['TELEGRAM_BOT_TOKEN', 'TOKENROUTER_API_KEY', 'PRIVATE_KEY', 'DATABASE_URL']) expect(options.env[secret]).toBeUndefined();
  });
});

describe('CommandRunner -- output, timeouts, serialization', () => {
  it('masks secrets in command output', async () => {
    const fc = fakeChild();
    const runner = new CommandRunner({ guard, mask: createMasker(['super-secret-router-key-123']), timeoutMs: 1000, spawnImpl: () => fc.child });
    const pending = runner.run({ program: 'git', args: ['log', '-1'] });
    await new Promise((r) => setTimeout(r, 10));
    fc.stdout.write('leaked super-secret-router-key-123 and TELEGRAM_BOT_TOKEN=123456:abcdefghijklmnopqrstuvwxyzABCDEFG\n');
    fc.close(0);
    const result = await pending;
    expect(result.stdout).not.toContain('super-secret-router-key-123');
    expect(result.stdout).toContain(MASK);
  });

  it('returns raw output only when the supervisor explicitly asks for it (secret scan input)', async () => {
    const fc = fakeChild();
    const runner = new CommandRunner({ guard, mask: createMasker(['super-secret-router-key-123']), timeoutMs: 1000, spawnImpl: () => fc.child });
    const pending = runner.run({ program: 'git', args: ['diff', '--cached', '--unified=0'] }, { unmasked: true });
    await new Promise((r) => setTimeout(r, 10));
    fc.stdout.write('+const k = "super-secret-router-key-123";\n');
    fc.close(0);
    const result = await pending;
    expect(result.stdout).toContain('super-secret-router-key-123');
    expect(result.command).toBe('git diff --cached --unified=0');
  });

  it('kills a command that exceeds its timeout and reports timedOut', async () => {
    const fc = fakeChild();
    fc.kill.mockImplementation(() => { fc.close(null); return true; });
    const runner = new CommandRunner({ guard, mask: createMasker([]), timeoutMs: 30, spawnImpl: () => fc.child });
    const result = await runner.run({ program: 'npm', args: ['run', 'test'] });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('runs commands one at a time', async () => {
    const children = [fakeChild(), fakeChild()];
    const spawnImpl = vi.fn(() => (children[spawnImpl.mock.calls.length - 1] as FakeChild).child);
    const runner = new CommandRunner({ guard, mask: createMasker([]), timeoutMs: 1000, spawnImpl });
    const first = runner.run({ program: 'git', args: ['status'] });
    const second = runner.run({ program: 'git', args: ['log', '-1'] });
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnImpl).toHaveBeenCalledTimes(1); // second waits for the first
    children[0]?.close(0);
    await first;
    await vi.waitFor(() => { expect(spawnImpl).toHaveBeenCalledTimes(2); });
    children[1]?.close(0);
    await expect(second).resolves.toMatchObject({ exitCode: 0 });
  });

  it('really runs git in a real repository (integration)', async () => {
    const realRunner = new CommandRunner({ guard, mask: createMasker([]), timeoutMs: 30_000 });
    fs.mkdirSync(path.join(workspace, '.git-probe'), { recursive: true });
    const result = await realRunner.run({ program: 'git', args: ['rev-parse', '--is-inside-work-tree'] });
    // the temp workspace is not a repo: git answers with a non-zero exit, proving it actually ran in the workspace cwd
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain('not a git repository');
  });
});

describe('buildChildEnv', () => {
  it('passes only an allowlist plus test-mode flags', () => {
    const env = buildChildEnv({ PATH: '/bin', HOME: '/opt/lunex/ai/home', GITHUB_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y', NODE_ENV: 'production' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/opt/lunex/ai/home', CI: '1', NODE_ENV: 'test', NO_COLOR: '1', FORCE_COLOR: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
  });
});

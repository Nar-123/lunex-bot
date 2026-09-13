import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearStaleGitLocks, listLinuxProcesses } from '../src/gitLock';
import type { ProcInfo } from '../src/gitLock';
import { recoverOnStartup } from '../src/recovery';
import { StateStore } from '../src/stateStore';
import { TaskQueue } from '../src/taskQueue';
import { silentLogger } from './helpers';

let root: string;
let workspace: string;
const lockFile = (name = 'index.lock'): string => path.join(workspace, '.git', name);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunex-ai-gitlock-'));
  workspace = path.join(root, 'lunex');
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const linux = (processes: ProcInfo[]) => ({ platform: 'linux' as const, processes: () => processes, selfPid: 1 });

describe('clearStaleGitLocks', () => {
  it('does nothing when there is no lock', () => {
    expect(clearStaleGitLocks(workspace, linux([]))).toEqual({ action: 'none', detail: 'no git lock files' });
  });

  it('removes index.lock and HEAD.lock left by a killed git command when no git process uses the repository', () => {
    fs.writeFileSync(lockFile(), '');
    fs.writeFileSync(lockFile('HEAD.lock'), '');
    const result = clearStaleGitLocks(workspace, linux([{ pid: 50, comm: 'node', cwd: workspace }, { pid: 51, comm: 'git', cwd: path.join(root, 'elsewhere') }]));
    expect(result.action).toBe('removed');
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(fs.existsSync(lockFile('HEAD.lock'))).toBe(false);
  });

  it('keeps the lock while a git process is working inside the repository', () => {
    fs.writeFileSync(lockFile(), '');
    const result = clearStaleGitLocks(workspace, linux([{ pid: 77, comm: 'git', cwd: path.join(workspace, 'src') }]));
    expect(result).toMatchObject({ action: 'kept' });
    expect(result.detail).toMatch(/77/);
    expect(fs.existsSync(lockFile())).toBe(true);
  });

  it('keeps the lock when a git process working directory cannot be read (conservative)', () => {
    fs.writeFileSync(lockFile(), '');
    expect(clearStaleGitLocks(workspace, linux([{ pid: 88, comm: 'git-remote-https', cwd: null }])).action).toBe('kept');
    expect(fs.existsSync(lockFile())).toBe(true);
  });

  it('ignores its own pid', () => {
    fs.writeFileSync(lockFile(), '');
    expect(clearStaleGitLocks(workspace, { platform: 'linux', processes: () => [{ pid: 1, comm: 'git', cwd: workspace }], selfPid: 1 }).action).toBe('removed');
  });

  it('never removes a lock where processes cannot be inspected', () => {
    fs.writeFileSync(lockFile(), '');
    expect(clearStaleGitLocks(workspace, { platform: 'win32', processes: () => [] }).action).toBe('kept');
    expect(fs.existsSync(lockFile())).toBe(true);
  });

  it('listLinuxProcesses reads comm and cwd from a proc-like tree and tolerates unreadable entries', () => {
    const proc = path.join(root, 'proc');
    fs.mkdirSync(path.join(proc, '100'), { recursive: true });
    fs.writeFileSync(path.join(proc, '100', 'comm'), 'git\n');
    fs.mkdirSync(path.join(proc, '200'), { recursive: true }); // exited between readdir and read
    fs.mkdirSync(path.join(proc, 'self'), { recursive: true });
    expect(listLinuxProcesses(proc)).toEqual([{ pid: 100, comm: 'git', cwd: null }]);
    expect(listLinuxProcesses(path.join(root, 'missing'))).toEqual([]);
  });
});

describe('recoverOnStartup + stale git locks', () => {
  it('clears stale locks before reading git, logs it and records it in the checkpoint', async () => {
    const store = new StateStore(path.join(root, 'state'));
    const logger = silentLogger();
    const order: string[] = [];
    await recoverOnStartup({
      store,
      queue: new TaskQueue(store),
      logger,
      clearStaleGitLocks: () => { order.push('locks'); return { action: 'removed', detail: 'index.lock removed' }; },
      snapshotGit: vi.fn(async () => { order.push('git'); return { branch: 'ai/develop', head: 'abc', dirty: false, changedFiles: [] }; }),
    });
    expect(order).toEqual(['locks', 'git']);
    expect(logger.warn).toHaveBeenCalledWith('stale_git_lock', { action: 'removed', detail: 'index.lock removed' });
    expect(store.getCheckpoints(1)[0]?.note).toMatch(/git lock removed: index.lock removed/);
  });

  it('a failing lock check never prevents recovery', async () => {
    const store = new StateStore(path.join(root, 'state'));
    const logger = silentLogger();
    const outcome = await recoverOnStartup({
      store,
      queue: new TaskQueue(store),
      logger,
      clearStaleGitLocks: () => { throw new Error('EACCES'); },
      snapshotGit: async () => ({ branch: 'ai/develop', head: 'abc', dirty: false, changedFiles: [] }),
    });
    expect(outcome.note).toBe('no task was in flight');
    expect(logger.warn).toHaveBeenCalledWith('stale_git_lock_check_failed', { message: 'EACCES' });
  });
});

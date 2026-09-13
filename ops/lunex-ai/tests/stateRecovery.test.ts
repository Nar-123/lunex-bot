import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitSnapshot } from '../src/gitOps';
import { recoverOnStartup } from '../src/recovery';
import { StateStore } from '../src/stateStore';
import { createTask, TaskQueue } from '../src/taskQueue';
import { silentLogger } from './helpers';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunex-ai-state-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const at = (s: string): Date => new Date(`2026-09-13T${s}Z`);
const cleanGit: GitSnapshot = { branch: 'ai/develop', head: 'abc123def4567890', dirty: false, changedFiles: [] };

describe('StateStore -- persistence', () => {
  it('persists every state file across a fresh instance (simulated restart)', () => {
    const store = new StateStore(dir);
    const task = createTask({ title: 't', description: 'd', priority: 'P2', source: 'telegram-command' }, at('10:00:00'), 'T-1');
    store.setCurrentTask({ ...task, status: 'running' });
    store.setQueue([task]);
    store.updateProgress({ paused: true, telegramOffset: 42 });
    store.addCheckpoint({ taskId: 'T-1', phase: 'implement', note: 'n', gitHead: null, gitDirty: null });
    store.appendCompleted(task);
    store.appendBlocked(task);

    const reopened = new StateStore(dir);
    expect(reopened.getCurrentTask()?.id).toBe('T-1');
    expect(reopened.getQueue()).toHaveLength(1);
    expect(reopened.getProgress()).toMatchObject({ paused: true, telegramOffset: 42 });
    expect(reopened.getCheckpoints()).toHaveLength(1);
    expect(reopened.getCompleted()).toHaveLength(1);
    expect(reopened.getBlocked()).toHaveLength(1);
    for (const name of ['current_task', 'queue', 'progress', 'checkpoints', 'completed', 'blocked']) {
      expect(fs.existsSync(path.join(dir, `${name}.json`))).toBe(true);
    }
  });

  it('leaves no temp files behind after writes', () => {
    const store = new StateStore(dir);
    store.updateProgress({ paused: false });
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('a corrupt file is moved aside, reported, and replaced by its default -- never a crash', () => {
    fs.writeFileSync(path.join(dir, 'queue.json'), '{ not json');
    const onCorrupt = vi.fn();
    const store = new StateStore(dir, () => at('10:00:00'), onCorrupt);
    expect(store.getQueue()).toEqual([]);
    expect(onCorrupt).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('queue.json.corrupt-'))).toBe(true);
  });
});

describe('TaskQueue -- priority ordering', () => {
  it('P0 before P4, oldest first within a priority, dequeue removes', () => {
    const queue = new TaskQueue(new StateStore(dir));
    queue.enqueue(createTask({ title: 'docs', description: '', priority: 'P4', source: 'autonomous' }, at('09:00:00'), 'T-docs'));
    queue.enqueue(createTask({ title: 'exit bug new', description: '', priority: 'P1', source: 'telegram-command' }, at('09:30:00'), 'T-p1-new'));
    queue.enqueue(createTask({ title: 'security', description: '', priority: 'P0', source: 'telegram-command' }, at('10:00:00'), 'T-p0'));
    queue.enqueue(createTask({ title: 'exit bug old', description: '', priority: 'P1', source: 'telegram-command' }, at('08:00:00'), 'T-p1-old'));

    expect(queue.list().map((t) => t.id)).toEqual(['T-p0', 'T-p1-old', 'T-p1-new', 'T-docs']);
    expect(queue.dequeueNext()?.id).toBe('T-p0');
    expect(queue.size()).toBe(3);
    expect(queue.clear()).toBe(3);
    expect(queue.dequeueNext()).toBeNull();
  });
});

describe('recoverOnStartup -- an interrupted task is never assumed complete', () => {
  it('re-queues a task found running, annotated with git state, and clears current_task', async () => {
    const store = new StateStore(dir, () => at('12:00:00'));
    const queue = new TaskQueue(store);
    const running = {
      ...createTask({ title: 'fix exit', description: 'd', priority: 'P1', source: 'telegram-command' }, at('09:00:00'), 'T-run'),
      status: 'running' as const,
      attempts: 1,
      branch: 'ai/fix-exit-t-run',
      steps: [{ at: at('09:05:00').toISOString(), phase: 'replace_in_file', note: 'ok: src/exits/swapTx.ts' }],
    };
    store.setCurrentTask(running);
    store.updateProgress({ stopRequested: true, paused: true });
    queue.enqueue(createTask({ title: 'newer same priority', description: '', priority: 'P1', source: 'telegram-command' }, at('11:00:00'), 'T-newer'));

    const outcome = await recoverOnStartup({
      store,
      queue,
      snapshotGit: async () => ({ branch: 'ai/fix-exit-t-run', head: 'feedbeefcafe0000', dirty: true, changedFiles: ['src/exits/swapTx.ts'] }),
      logger: silentLogger(),
      now: () => at('12:00:00'),
    });

    expect(outcome.recoveredTask?.id).toBe('T-run');
    expect(store.getCurrentTask()).toBeNull();
    const [first, second] = queue.list();
    expect(first?.id).toBe('T-run'); // older task of the same priority resumes first
    expect(second?.id).toBe('T-newer');
    expect(first?.status).toBe('queued');
    expect(first?.branch).toBe('ai/fix-exit-t-run'); // resumes on its own branch
    const note = first?.steps.at(-1)?.note ?? '';
    expect(note).toMatch(/completion NOT assumed/);
    expect(note).toMatch(/uncommitted=1/);
    expect(note).toMatch(/replace_in_file/);
    expect(store.getCompleted()).toEqual([]); // never recorded as completed
    expect(store.getCheckpoints(1)[0]).toMatchObject({ taskId: 'T-run', phase: 'recovery', gitDirty: true });
    expect(store.getProgress()).toMatchObject({ stopRequested: false, paused: true }); // a pause survives a restart; a pending stop does not
  });

  it('still recovers when git is unavailable', async () => {
    const store = new StateStore(dir);
    const queue = new TaskQueue(store);
    store.setCurrentTask({ ...createTask({ title: 't', description: '', priority: 'P2', source: 'autonomous' }, at('09:00:00'), 'T-x'), status: 'running' });
    const outcome = await recoverOnStartup({ store, queue, snapshotGit: async () => { throw new Error('git missing'); }, logger: silentLogger() });
    expect(outcome.recoveredTask?.id).toBe('T-x');
    expect(outcome.note).toMatch(/git state unavailable/);
  });

  it('a task that had already reached a terminal state is moved to history once, not re-run and not duplicated', async () => {
    const store = new StateStore(dir);
    const queue = new TaskQueue(store);
    const done = { ...createTask({ title: 't', description: '', priority: 'P2', source: 'autonomous' }, at('09:00:00'), 'T-done'), status: 'completed' as const };
    store.setCurrentTask(done);
    await recoverOnStartup({ store, queue, snapshotGit: async () => cleanGit, logger: silentLogger() });
    store.setCurrentTask(done);
    await recoverOnStartup({ store, queue, snapshotGit: async () => cleanGit, logger: silentLogger() });

    expect(store.getCompleted().filter((t) => t.id === 'T-done')).toHaveLength(1);
    expect(queue.size()).toBe(0);
    expect(store.getCurrentTask()).toBeNull();
  });

  it('with nothing in flight, records a startup checkpoint only', async () => {
    const store = new StateStore(dir);
    const outcome = await recoverOnStartup({ store, queue: new TaskQueue(store), snapshotGit: async () => cleanGit, logger: silentLogger() });
    expect(outcome.recoveredTask).toBeNull();
    expect(store.getCheckpoints(1)[0]).toMatchObject({ phase: 'startup', gitHead: cleanGit.head });
  });
});

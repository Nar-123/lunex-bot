import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../src/commandRunner';
import type { SupervisorConfig } from '../src/config';
import type { GitOps } from '../src/gitOps';
import type { LlmClient } from '../src/llm/tokenRouterClient';
import type { ScopeGuard } from '../src/scopeGuard';
import { createMasker } from '../src/secretMask';
import { StateStore } from '../src/stateStore';
import { CONTINUE_DESCRIPTION, Supervisor } from '../src/supervisor/supervisor';
import { TaskQueue } from '../src/taskQueue';
import { silentLogger } from './helpers';

let dir: string;
let clock: Date;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunex-ai-supervisor-'));
  clock = new Date('2026-09-13T08:00:00Z');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function make(configOverrides: Partial<SupervisorConfig> = {}) {
  const store = new StateStore(dir, () => clock);
  const queue = new TaskQueue(store);
  const config = { integrationBranch: 'ai/develop', model: 'z-ai/glm-5.3-free', autonomousIdle: true, idleTaskCooldownMs: 30 * 60 * 1000, maxSelfTasksPerDay: 2, maxAgentSteps: 5, maxDebugRounds: 1, ...configOverrides } as SupervisorConfig;
  const git = { snapshot: vi.fn(async () => ({ branch: 'ai/develop', head: 'abc', dirty: false, changedFiles: [] })) } as unknown as GitOps;
  const supervisor = new Supervisor({
    config,
    store,
    queue,
    git,
    runner: {} as CommandRunner,
    guard: {} as ScopeGuard,
    llm: {} as LlmClient,
    logger: silentLogger(),
    mask: createMasker([]),
    notifyText: vi.fn(async () => undefined),
    now: () => clock,
    sleep: vi.fn(async () => undefined),
  });
  return { supervisor, store, queue };
}

describe('Supervisor control signals', () => {
  it('maps persisted progress to continue / pause / stop', () => {
    const { supervisor, store } = make();
    expect(supervisor.control()).toBe('continue');
    store.updateProgress({ paused: true });
    expect(supervisor.control()).toBe('pause');
    store.updateProgress({ stopRequested: true });
    expect(supervisor.control()).toBe('stop');
  });

  it('/pause and /resume persist; /stop with nothing running pauses instead of requesting a stop', () => {
    const { supervisor, store } = make();
    supervisor.pause();
    expect(store.getProgress().paused).toBe(true);
    supervisor.resume();
    expect(store.getProgress()).toMatchObject({ paused: false, stopRequested: false });
    expect(supervisor.stop()).toMatch(/No task running/);
    expect(store.getProgress()).toMatchObject({ paused: true, stopRequested: false });
  });

  it('shutdown turns every control check into pause (safe point + re-queue)', () => {
    const { supervisor } = make();
    supervisor.shutdown();
    expect(supervisor.control()).toBe('pause');
  });
});

describe('Supervisor /continue and autonomous idle work', () => {
  it('/continue resumes a paused worker, otherwise queues a continue-development task', () => {
    const { supervisor, store, queue } = make();
    store.updateProgress({ paused: true });
    expect(supervisor.continueWork()).toMatch(/Resumed/);
    expect(queue.size()).toBe(0);

    expect(supervisor.continueWork()).toMatch(/Queued/);
    expect(queue.list()[0]).toMatchObject({ description: CONTINUE_DESCRIPTION, priority: 'P3', allowStrategyChange: false });
    expect(supervisor.continueWork()).toMatch(/Already working/);
  });

  it('an idle worker creates autonomous tasks respecting the cooldown and the daily cap', async () => {
    const { supervisor, store, queue } = make();
    // one idle pass: runWorker sees an empty queue, creates a task, then we stop it
    const idlePass = async (): Promise<void> => {
      const run = supervisor.runWorker();
      supervisor.shutdown();
      await run;
      (supervisor as unknown as { shuttingDown: boolean }).shuttingDown = false;
    };

    await idlePass();
    expect(queue.size()).toBe(1);
    queue.clear();

    await idlePass(); // within cooldown
    expect(queue.size()).toBe(0);

    clock = new Date('2026-09-13T08:31:00Z');
    await idlePass();
    expect(queue.size()).toBe(1);
    queue.clear();

    clock = new Date('2026-09-13T09:05:00Z');
    await idlePass(); // daily cap (2) reached
    expect(queue.size()).toBe(0);
    expect(store.getProgress().selfTasks).toEqual({ date: '2026-09-13', count: 2 });

    clock = new Date('2026-09-14T09:05:00Z');
    await idlePass(); // new day
    expect(queue.size()).toBe(1);
  });

  it('never creates autonomous tasks when disabled', async () => {
    const { supervisor, queue } = make({ autonomousIdle: false });
    const run = supervisor.runWorker();
    supervisor.shutdown();
    await run;
    expect(queue.size()).toBe(0);
  });

  it('/status always states that production is not touched', async () => {
    const { supervisor } = make();
    expect(await supervisor.status()).toMatch(/Production: NOT TOUCHED/);
  });
});

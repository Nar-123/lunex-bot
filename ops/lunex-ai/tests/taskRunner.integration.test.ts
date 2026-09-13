import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlSignal } from '../src/agent/agentLoop';
import { CommandRunner } from '../src/commandRunner';
import type { SupervisorConfig } from '../src/config';
import { GitOps } from '../src/gitOps';
import type { ChatMessage, LlmClient } from '../src/llm/tokenRouterClient';
import { ScopeGuard } from '../src/scopeGuard';
import { createMasker } from '../src/secretMask';
import { StateStore } from '../src/stateStore';
import type { Task } from '../src/stateStore';
import { Supervisor } from '../src/supervisor/supervisor';
import { runTask } from '../src/supervisor/taskRunner';
import type { TaskRunnerDeps } from '../src/supervisor/taskRunner';
import { createTask, TaskQueue } from '../src/taskQueue';
import type { VerificationReport } from '../src/verification';
import { silentLogger } from './helpers';

/**
 * Real git repository, real CommandRunner (allowlist + scope guard), real
 * GitOps -- only the model and the Lunex verification commands are faked.
 */
let root: string;
let workspace: string;

const PASS: VerificationReport = { passed: true, steps: ['typecheck', 'lint', 'test', 'build'].map((name) => ({ name, passed: true, exitCode: 0, timedOut: false, durationMs: 1, outputTail: '', summary: name === 'test' ? 'Tests 818 passed (818)' : '' })) };
const FAIL: VerificationReport = { passed: false, steps: [{ name: 'test', passed: false, exitCode: 1, timedOut: false, durationMs: 1, outputTail: 'boom', summary: 'Tests 1 failed' }] };

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunex-ai-runner-'));
  workspace = path.join(root, 'lunex');
  fs.mkdirSync(path.join(workspace, 'src', 'config'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'config', 'constants.ts'), 'export const HARD_STOP_LOSS_PCT = -0.06;\n');
  fs.writeFileSync(path.join(workspace, 'src', 'app.ts'), 'export const app = 1;\n');
  fs.writeFileSync(path.join(workspace, '.gitignore'), '.ai/\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'lunex-ai@test.invalid');
  git('config', 'user.name', 'Lunex AI Test');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const act = (a: Record<string, unknown>): string => JSON.stringify({ thought: 't', action: a });
const done = (status = 'COMPLETED'): string => act({ type: 'finish', status, summary: 'summary', rootCause: 'root cause', next: 'next thing', reason: status === 'COMPLETED' ? undefined : 'agent reason' });

function llmOf(replies: (string | Error)[]): LlmClient {
  return {
    complete: vi.fn(async (_m: readonly ChatMessage[]) => {
      const next = replies.shift();
      if (next === undefined) throw new Error('script exhausted');
      if (next instanceof Error) throw next;
      return { content: next, promptTokens: null, completionTokens: null };
    }),
  };
}

function makeDeps(llm: LlmClient, overrides: Partial<TaskRunnerDeps> = {}) {
  const mask = createMasker([]);
  const guard = new ScopeGuard({ workspaceDir: workspace, aiHomeDir: path.join(root, 'ai'), deniedRoots: [path.join(root, 'production')] });
  const runner = new CommandRunner({ guard, mask, timeoutMs: 60_000 });
  const store = new StateStore(path.join(workspace, '.ai', 'state'));
  const queue = new TaskQueue(store);
  const notify = vi.fn(async (_t: Task) => undefined);
  const deps: TaskRunnerDeps = {
    store,
    queue,
    git: new GitOps(runner),
    runner,
    guard,
    llm,
    logger: silentLogger(),
    mask,
    integrationBranch: 'ai/develop',
    maxAgentSteps: 10,
    maxDebugRounds: 1,
    control: (): ControlSignal => 'continue',
    notify,
    verify: vi.fn(async () => PASS),
    ...overrides,
  };
  return { deps, store, queue, notify, runner, guard };
}

const newTask = (title: string, allowStrategyChange = false): Task => createTask({ title, description: title, priority: 'P2', source: 'telegram-command', allowStrategyChange }, new Date(), `T-20260913-130000-${Math.random().toString(16).slice(2, 6)}`);

describe('runTask -- completed work is committed and fast-forwarded, never pushed', () => {
  it('verified non-strategy change: commit on ai/<task> branch, ff into ai/develop, clean tree, report sent', async () => {
    const { deps, store, notify } = makeDeps(llmOf([act({ type: 'write_file', path: 'src/feature.ts', content: 'export const feature = true;\n' }), done()]));
    const task = newTask('Add feature flag');

    const outcome = await runTask(task, deps);

    expect(outcome.task.status).toBe('completed');
    expect(outcome.task.result?.status).toBe('COMPLETED');
    expect(outcome.task.result?.changes).toEqual(['src/feature.ts']);
    expect(outcome.task.result?.tests).toMatch(/818 passed/);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('ai/develop');
    expect(git('log', '-1', '--format=%s', 'ai/develop')).toBe('Add feature flag');
    expect(git('status', '--porcelain')).toBe('');
    expect(git('log', '-1', '--format=%s', 'main')).toBe('initial'); // main untouched
    expect(git('remote')).toBe(''); // nothing to push to, and nothing pushed
    expect(store.getCompleted().map((t) => t.id)).toEqual([task.id]);
    expect(store.getCurrentTask()).toBeNull();
    const report = notify.mock.calls[0]?.[0];
    expect(report?.result?.git).toMatch(/fast-forwarded into ai\/develop \(not pushed\)/);
  });
});

describe('runTask -- strategy guard (enforced in code)', () => {
  it('a strategy-sensitive change without permission is committed on its own branch only and reported BLOCKED', async () => {
    const { deps, store } = makeDeps(llmOf([act({ type: 'replace_in_file', path: 'src/config/constants.ts', old: '-0.06', new: '-0.15' }), done()]));
    const task = newTask('Tune the stop loss');

    const outcome = await runTask(task, deps);

    expect(outcome.task.result?.status).toBe('BLOCKED');
    expect(outcome.task.result?.reason).toMatch(/strategy-sensitive files changed without explicit permission: src\/config\/constants.ts/);
    expect(outcome.task.result?.requiredAction).toMatch(new RegExp(`/approve ${task.id}`));
    expect(git('show', 'ai/develop:src/config/constants.ts')).toContain('-0.06'); // integration branch unchanged
    expect(git('show', `${outcome.task.branch ?? ''}:src/config/constants.ts`)).toContain('-0.15');
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('ai/develop');
    expect(store.getBlocked().map((t) => t.id)).toEqual([task.id]);

    // operator approval merges it after re-verification
    const supervisor = new Supervisor({ ...deps, config: { integrationBranch: 'ai/develop' } as SupervisorConfig, notifyText: vi.fn(async () => undefined) });
    expect(await supervisor.approve(task.id)).toMatch(/^Approved/);
    expect(git('show', 'ai/develop:src/config/constants.ts')).toContain('-0.15');
    expect(store.getCompleted().some((t) => t.id === task.id && t.steps.some((s) => s.phase === 'approved'))).toBe(true);
  });

  it('with explicit operator permission the same change is merged', async () => {
    const { deps } = makeDeps(llmOf([act({ type: 'replace_in_file', path: 'src/config/constants.ts', old: '-0.06', new: '-0.08' }), done()]));
    const outcome = await runTask(newTask('Widen stop loss as instructed', true), deps);
    expect(outcome.task.result?.status).toBe('COMPLETED');
    expect(git('show', 'ai/develop:src/config/constants.ts')).toContain('-0.08');
  });
});

describe('runTask -- nothing unsafe is ever committed', () => {
  it('secret-looking content blocks the commit and pauses the worker; the file is kept for inspection', async () => {
    const { deps } = makeDeps(llmOf([act({ type: 'write_file', path: 'src/leak.ts', content: "export const key = 'sk-abcdefghijklmnopqrstuvwxyz123456';\n" }), done()]));
    const outcome = await runTask(newTask('Add client'), deps);

    expect(outcome.task.result?.status).toBe('BLOCKED');
    expect(outcome.task.result?.reason).toMatch(/secret-looking content/);
    expect(outcome.pauseWorker).toBe(true);
    expect(git('log', '--all', '--format=%s')).not.toMatch(/Add client/);
    expect(fs.existsSync(path.join(workspace, 'src', 'leak.ts'))).toBe(true); // never discarded
  });

  it('verification that keeps failing ends FAILED with a WIP commit on the task branch, not merged', async () => {
    const { deps } = makeDeps(llmOf([act({ type: 'write_file', path: 'src/broken.ts', content: 'export const x = 1;\n' }), done(), done()]), { verify: vi.fn(async () => FAIL) });
    const outcome = await runTask(newTask('Broken change'), deps);

    expect(outcome.task.status).toBe('failed');
    expect(outcome.task.result?.status).toBe('FAILED');
    expect(outcome.task.result?.tests).toMatch(/FAIL/);
    expect(git('log', '-1', '--format=%s', outcome.task.branch ?? '')).toMatch(/^WIP \[unverified\]/);
    expect(git('branch', '--list', 'ai/develop')).not.toBe('');
    expect(() => git('cat-file', '-e', 'ai/develop:src/broken.ts')).toThrow();
  });

  it('a dirty tree from outside any task blocks the task and pauses -- uncommitted work is never discarded', async () => {
    fs.writeFileSync(path.join(workspace, 'src', 'app.ts'), 'export const app = 2; // operator edit\n');
    const { deps } = makeDeps(llmOf([done()]));
    const outcome = await runTask(newTask('Anything'), deps);

    expect(outcome.task.result?.status).toBe('BLOCKED');
    expect(outcome.pauseWorker).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'src', 'app.ts'), 'utf8')).toContain('operator edit');
  });
});

describe('runTask -- interruption and recovery paths re-queue instead of finishing', () => {
  it('a model gateway error re-queues the task with backoff and keeps its branch', async () => {
    const { deps, queue, store } = makeDeps(llmOf([new Error('TokenRouter HTTP 503')]));
    const task = newTask('Gateway flake');
    const outcome = await runTask(task, deps);

    expect(outcome.requeued).toBe(true);
    expect(outcome.llmBackoff).toBe(true);
    const [queued] = queue.list();
    expect(queued?.id).toBe(task.id);
    expect(queued?.branch).toMatch(/^ai\/gateway-flake-/);
    expect(queued?.attempts).toBe(1);
    expect(store.getCompleted()).toEqual([]);
  });

  it('pause stops at a safe point, preserves work as WIP on the task branch, and re-queues; the resumed attempt continues on that branch', async () => {
    let signal: ControlSignal = 'continue';
    const llm = llmOf([
      act({ type: 'write_file', path: 'src/half.ts', content: 'export const half = 1;\n' }),
      // after resume:
      act({ type: 'replace_in_file', path: 'src/half.ts', old: 'half = 1', new: 'half = 2' }),
      done(),
    ]);
    const { deps, queue } = makeDeps(llm, { control: () => signal });
    const task = newTask('Two part change');
    (deps.llm.complete as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      signal = 'pause';
      return { content: act({ type: 'write_file', path: 'src/half.ts', content: 'export const half = 1;\n' }), promptTokens: null, completionTokens: null };
    });

    const first = await runTask(task, deps);
    expect(first.requeued).toBe(true);
    const branch = first.task.branch ?? '';
    expect(git('log', '-1', '--format=%s', branch)).toMatch(/^WIP \[unverified\] interrupted \(pause\)/);

    signal = 'continue';
    const resumedTask = queue.dequeueNext();
    if (!resumedTask) throw new Error('task was not re-queued');
    llm.complete = vi.fn()
      .mockResolvedValueOnce({ content: act({ type: 'replace_in_file', path: 'src/half.ts', old: 'half = 1', new: 'half = 2' }), promptTokens: null, completionTokens: null })
      .mockResolvedValueOnce({ content: done(), promptTokens: null, completionTokens: null });
    const second = await runTask(resumedTask, { ...deps, llm });

    expect(second.task.result?.status).toBe('COMPLETED');
    expect(second.task.branch).toBe(branch);
    expect(second.task.attempts).toBe(2);
    expect(git('show', 'ai/develop:src/half.ts')).toContain('half = 2');
  });
});

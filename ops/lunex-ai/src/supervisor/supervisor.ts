import type { ControlSignal } from '../agent/agentLoop';
import type { CommandRunner } from '../commandRunner';
import type { SupervisorConfig } from '../config';
import type { GitOps } from '../gitOps';
import type { LlmClient } from '../llm/tokenRouterClient';
import type { Logger } from '../logger';
import type { ScopeGuard } from '../scopeGuard';
import type { Masker } from '../secretMask';
import type { Priority, StateStore, Task, TaskSource } from '../stateStore';
import { createTask } from '../taskQueue';
import type { TaskQueue } from '../taskQueue';
import { formatStep, formatVerification, runVerification } from '../verification';
import type { VerificationReport } from '../verification';
import { formatTaskReport } from './report';
import { runTask } from './taskRunner';

export const CONTINUE_DESCRIPTION = `Continue developing Lunex from the current state. Pick the single highest-value, SAFE unfinished item:
1. Read README.md "Module status" unchecked items, recent .ai/reports, recently blocked/failed tasks, and TODO/FIXME comments.
2. Run the test suite if unsure whether anything is failing.
3. Prioritise: P0 security/data corruption -> P1 trading correctness/execution/position lifecycle -> P2 reliability/RPC/state -> P3 tests/refactoring -> P4 docs.
Do not invent product requirements, do not redo completed work, do not change trading strategy.
Fix ONE item with regression tests, then finish. If nothing safe and well-evidenced remains, finish BLOCKED and say so.`;

export const AUDIT_DESCRIPTION = (scope: string): string => `Audit ${scope} of the Lunex codebase for correctness, safety and security defects.
Focus on failure paths, crash recovery, idempotency, state consistency, secret handling and missing tests.
For each finding cite file:line evidence. Fix findings that can be fixed safely WITHOUT changing trading strategy, with regression tests.
Findings that would change trading behaviour or are ambiguous: do not change them; list them in the finish summary with status BLOCKED if nothing was safely fixable.`;

export interface SupervisorDeps {
  config: SupervisorConfig;
  store: StateStore;
  queue: TaskQueue;
  git: GitOps;
  runner: CommandRunner;
  guard: ScopeGuard;
  llm: LlmClient;
  logger: Logger;
  mask: Masker;
  notifyText: (text: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  verify?: () => Promise<VerificationReport>;
}

/** The operations the Telegram bot may invoke. Nothing here trades, deploys, or reads secrets. */
export interface SupervisorControl {
  status(): Promise<string>;
  progress(): string;
  queueList(): string;
  addTask(text: string, source: TaskSource, options?: { priority?: Priority; allowStrategyChange?: boolean }): Task;
  continueWork(): string;
  pause(): string;
  resume(): string;
  stop(): string;
  clearQueue(): string;
  runTests(): Promise<string>;
  runBuild(): Promise<string>;
  diff(): Promise<string>;
  gitInfo(): Promise<string>;
  log(lines: number): string;
  audit(scope: string): Task;
  approve(taskId: string): Promise<string>;
  restart(): string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const LLM_BACKOFF_MS = 5 * 60 * 1000;

export class Supervisor implements SupervisorControl {
  private shuttingDown = false;
  private maintenance = false;
  private activeTaskId: string | null = null;
  private llmBackoffUntil = 0;
  onRestartRequested: (() => void) | null = null;

  constructor(private readonly deps: SupervisorDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? defaultSleep)(ms);
  }

  readonly control = (): ControlSignal => {
    const progress = this.deps.store.getProgress();
    if (progress.stopRequested) return 'stop';
    if (this.shuttingDown || progress.paused) return 'pause';
    return 'continue';
  };

  /** Worker loop. Returns once `shutdown()` is called and any running task has reached a safe point. */
  async runWorker(): Promise<void> {
    const { store, queue, logger } = this.deps;
    logger.info('worker_started', {});
    while (!this.shuttingDown) {
      store.updateProgress({ lastHeartbeatAt: this.now().toISOString() });
      const progress = store.getProgress();
      if (progress.stopRequested && this.activeTaskId === null) store.updateProgress({ stopRequested: false });
      if (progress.paused || this.maintenance || this.now().getTime() < this.llmBackoffUntil) {
        await this.sleep(5000);
        continue;
      }
      const task = queue.dequeueNext();
      if (!task) {
        this.maybeCreateIdleTask();
        await this.sleep(10_000);
        continue;
      }
      await this.runOne(task);
    }
    logger.info('worker_stopped', {});
  }

  /** Exposed for tests: runs exactly one task through the full pipeline. */
  async runOne(task: Task): Promise<void> {
    const { store, logger } = this.deps;
    this.activeTaskId = task.id;
    logger.info('task_started', { taskId: task.id, title: task.title, priority: task.priority });
    try {
      const outcome = await runTask(task, {
        store,
        queue: this.deps.queue,
        git: this.deps.git,
        runner: this.deps.runner,
        guard: this.deps.guard,
        llm: this.deps.llm,
        logger,
        mask: this.deps.mask,
        integrationBranch: this.deps.config.integrationBranch,
        maxAgentSteps: this.deps.config.maxAgentSteps,
        maxDebugRounds: this.deps.config.maxDebugRounds,
        control: this.control,
        notify: (t) => this.deps.notifyText(formatTaskReport(t)),
        ...(this.deps.verify ? { verify: this.deps.verify } : {}),
        ...(this.deps.now ? { now: this.deps.now } : {}),
      });
      if (outcome.task.status === 'stopped') store.updateProgress({ stopRequested: false, paused: true });
      if (outcome.pauseWorker) {
        store.updateProgress({ paused: true });
        await this.safeNotify(`LUNEX AI\n\nWorker PAUSED after task ${outcome.task.id}: ${outcome.task.result?.reason ?? 'needs operator attention'}\nSend /resume once resolved.`);
      }
      if (outcome.llmBackoff) this.llmBackoffUntil = this.now().getTime() + LLM_BACKOFF_MS;
    } finally {
      this.activeTaskId = null;
    }
  }

  /** Stops picking up work; a running task reaches its next safe point and is re-queued. Await `runWorker()` to know when that happened. */
  shutdown(): void {
    this.shuttingDown = true;
  }

  private async safeNotify(text: string): Promise<void> {
    try {
      await this.deps.notifyText(text);
    } catch (err) {
      this.deps.logger.error('notify_failed', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  private maybeCreateIdleTask(): void {
    const { config, store, queue } = this.deps;
    if (!config.autonomousIdle) return;
    const progress = store.getProgress();
    const today = this.now().toISOString().slice(0, 10);
    const count = progress.selfTasks.date === today ? progress.selfTasks.count : 0;
    if (count >= config.maxSelfTasksPerDay) return;
    if (progress.lastIdleTaskAt && this.now().getTime() - Date.parse(progress.lastIdleTaskAt) < config.idleTaskCooldownMs) return;
    queue.enqueue(createTask({ title: 'Continue developing Lunex', description: CONTINUE_DESCRIPTION, priority: 'P3', source: 'autonomous' }, this.now()));
    store.updateProgress({ lastIdleTaskAt: this.now().toISOString(), selfTasks: { date: today, count: count + 1 } });
    this.deps.logger.info('autonomous_task_created', { count: count + 1 });
  }

  // ---- control API ------------------------------------------------------

  async status(): Promise<string> {
    const { store, queue, config } = this.deps;
    const progress = store.getProgress();
    const current = store.getCurrentTask();
    const lastStep = current?.steps[current.steps.length - 1];
    const checkpoint = store.getCheckpoints(1)[0];
    const git = await this.deps.git.snapshot().catch(() => null);
    const worker = progress.stopRequested ? 'STOP REQUESTED' : progress.paused ? 'PAUSED' : this.now().getTime() < this.llmBackoffUntil ? 'BACKING OFF (model gateway error)' : current ? 'WORKING' : 'IDLE';
    return [
      'LUNEX AI -- STATUS',
      `Worker: ${worker}`,
      `Current task: ${current ? `${current.id} ${current.title} (${current.priority}, attempt ${String(current.attempts)})` : '(none)'}`,
      `Last step: ${lastStep ? `${lastStep.phase}: ${lastStep.note}` : '(none)'}`,
      `Queue: ${String(queue.size())}`,
      `Model: ${config.model} via TokenRouter`,
      `Git: ${git ? `${git.branch ?? '?'} @ ${git.head?.slice(0, 10) ?? '?'}${git.dirty ? ` (${String(git.changedFiles.length)} uncommitted)` : ' (clean)'}` : 'unavailable'}`,
      `Last checkpoint: ${checkpoint ? `${checkpoint.at} ${checkpoint.phase}: ${checkpoint.note}` : '(none)'}`,
      'Production: NOT TOUCHED',
    ].join('\n');
  }

  progress(): string {
    const { store } = this.deps;
    const current = store.getCurrentTask();
    const steps = current ? current.steps.slice(-12).map((s) => `${s.at.slice(11, 19)} ${s.phase}: ${s.note}`).join('\n') : '';
    const completed = store.getCompleted(5).map((t) => `- ${t.id} ${t.title}`).join('\n') || '(none)';
    const blocked = store.getBlocked(5).map((t) => `- ${t.id} [${t.result?.status ?? t.status}] ${t.title}`).join('\n') || '(none)';
    const checkpoints = store.getCheckpoints(5).map((c) => `- ${c.at.slice(0, 19)} ${c.phase}: ${c.note}`).join('\n') || '(none)';
    return [
      'LUNEX AI -- PROGRESS',
      current ? `Task ${current.id}: ${current.title}\nBranch: ${current.branch ?? '(not yet)'}\n${steps || '(no steps yet)'}` : 'No task running.',
      `\nRecently completed:\n${completed}`,
      `\nRecently blocked/failed:\n${blocked}`,
      `\nCheckpoints:\n${checkpoints}`,
    ].join('\n');
  }

  queueList(): string {
    const tasks = this.deps.queue.list();
    if (tasks.length === 0) return 'Queue is empty.';
    return ['LUNEX AI -- QUEUE', ...tasks.slice(0, 30).map((t, i) => `${String(i + 1)}. [${t.priority}] ${t.id} ${t.title}${t.status === 'interrupted' || t.attempts > 0 ? ` (resume, attempt ${String(t.attempts)})` : ''}`)].join('\n');
  }

  addTask(text: string, source: TaskSource, options: { priority?: Priority; allowStrategyChange?: boolean } = {}): Task {
    const title = text.split('\n')[0]?.slice(0, 120) ?? 'Task';
    const task = createTask({ title, description: text, priority: options.priority ?? 'P2', source, allowStrategyChange: options.allowStrategyChange ?? false }, this.now());
    const queued = this.deps.queue.enqueue(task);
    this.deps.logger.info('task_enqueued', { taskId: queued.id, priority: queued.priority, source, allowStrategyChange: queued.allowStrategyChange });
    return queued;
  }

  continueWork(): string {
    const progress = this.deps.store.getProgress();
    if (progress.paused) {
      this.deps.store.updateProgress({ paused: false, stopRequested: false });
      return 'Resumed. The worker continues with the queue (interrupted tasks resume first within their priority).';
    }
    if (this.deps.queue.size() > 0 || this.activeTaskId !== null) return 'Already working. Use /queue or /progress.';
    const task = this.addTask(CONTINUE_DESCRIPTION, 'telegram-command', { priority: 'P3' });
    return `Queued ${task.id}: continue developing Lunex (highest-value safe item).`;
  }

  pause(): string {
    this.deps.store.updateProgress({ paused: true });
    return this.activeTaskId ? 'Pausing: the running task stops at its next safe point, work is committed as WIP on its branch and re-queued.' : 'Paused.';
  }

  resume(): string {
    this.deps.store.updateProgress({ paused: false, stopRequested: false });
    this.llmBackoffUntil = 0;
    return 'Resumed.';
  }

  stop(): string {
    if (!this.activeTaskId) {
      this.deps.store.updateProgress({ paused: true });
      return 'No task running. Worker paused; /resume to continue.';
    }
    this.deps.store.updateProgress({ stopRequested: true });
    return `Stopping ${this.activeTaskId} at its next safe point (work kept as WIP on its branch). The worker will pause afterwards.`;
  }

  clearQueue(): string {
    const removed = this.deps.queue.clear();
    return `Cleared ${String(removed)} queued task(s). A running task is not affected.`;
  }

  async runTests(): Promise<string> {
    const report = await runVerification(this.deps.runner, [{ name: 'test', request: { program: 'npm', args: ['run', 'test'] } }]);
    return this.verificationText('TEST', report);
  }

  async runBuild(): Promise<string> {
    const report = await runVerification(this.deps.runner, [
      { name: 'typecheck', request: { program: 'npm', args: ['run', 'typecheck'] } },
      { name: 'lint', request: { program: 'npm', args: ['run', 'lint'] } },
      { name: 'build', request: { program: 'npm', args: ['run', 'build'] } },
    ]);
    return this.verificationText('BUILD', report);
  }

  private verificationText(label: string, report: VerificationReport): string {
    const failedTail = report.steps.filter((s) => !s.passed).map((s) => `--- ${s.name} (tail) ---\n${s.outputTail.split('\n').slice(-25).join('\n')}`).join('\n');
    return `LUNEX AI -- ${label}\n${report.passed ? 'PASS' : 'FAIL'}\n${formatVerification(report)}${failedTail ? `\n\n${failedTail}` : ''}`;
  }

  async diff(): Promise<string> {
    const stat = await this.deps.git.diffStat();
    const body = await this.deps.git.diff(3000);
    return stat === '' ? 'No uncommitted changes.' : `LUNEX AI -- DIFF\n${stat}\n\n${body}`;
  }

  async gitInfo(): Promise<string> {
    const snap = await this.deps.git.snapshot();
    const log = await this.deps.git.logOneline(8);
    return [
      'LUNEX AI -- GIT',
      `Branch: ${snap.branch ?? '?'}`,
      `HEAD: ${snap.head ?? '?'}`,
      `Uncommitted: ${String(snap.changedFiles.length)}${snap.changedFiles.length > 0 ? `\n${snap.changedFiles.slice(0, 15).map((f) => `  ${f}`).join('\n')}` : ''}`,
      `Integration branch: ${this.deps.config.integrationBranch} (never pushed automatically)`,
      '',
      log,
    ].join('\n');
  }

  log(lines: number): string {
    const tail = this.deps.logger.tail(Math.min(Math.max(lines, 1), 50));
    return tail.length === 0 ? 'No log lines yet.' : tail.join('\n');
  }

  audit(scope: string): Task {
    const target = scope.trim() === '' ? 'the whole codebase (start with execution/, exits/, positions/)' : scope.trim();
    return this.addTask(AUDIT_DESCRIPTION(target), 'telegram-command', { priority: 'P2' });
  }

  async approve(taskId: string): Promise<string> {
    const { store, git, config } = this.deps;
    if (this.activeTaskId !== null || this.maintenance) return 'Busy: a task is running. /pause, wait for it to requeue, then /approve again.';
    const task = store.getBlocked(200).reverse().find((t) => t.id === taskId);
    if (!task?.branch || !task.commit || task.result?.status !== 'BLOCKED') return `No approvable BLOCKED task ${taskId} with a committed branch was found.`;
    this.maintenance = true;
    try {
      const snap = await git.snapshot();
      if (snap.dirty) return 'Refusing: the workspace has uncommitted changes.';
      await git.checkout(task.branch);
      const verification = await (this.deps.verify ?? (() => runVerification(this.deps.runner)))();
      if (!verification.passed) {
        await git.checkout(config.integrationBranch);
        return `Approval aborted: verification failed on ${task.branch}.\n${formatVerification(verification)}`;
      }
      try {
        await git.fastForward(config.integrationBranch, task.branch);
      } catch (err) {
        return `Approval aborted: ${this.deps.mask(err instanceof Error ? err.message : String(err))}\nThe integration branch moved on; re-submit the task so it is rebuilt on top.`;
      }
      store.appendCompleted({
        ...task,
        status: 'completed',
        allowStrategyChange: true,
        updatedAt: this.now().toISOString(),
        steps: [...task.steps, { at: this.now().toISOString(), phase: 'approved', note: 'approved by operator via Telegram' }],
        result: { ...task.result, status: 'COMPLETED', tests: verification.steps.filter((s) => s.name === 'test').map(formatStep).join('\n'), git: `${task.branch} fast-forwarded into ${config.integrationBranch} after operator approval (not pushed)` },
      });
      store.addCheckpoint({ taskId, phase: 'approved', note: `merged ${task.branch}`, gitHead: null, gitDirty: false });
      this.deps.logger.info('task_approved', { taskId, branch: task.branch });
      return `Approved ${taskId}: ${task.branch} verified and fast-forwarded into ${config.integrationBranch}. Not pushed.`;
    } finally {
      this.maintenance = false;
    }
  }

  restart(): string {
    this.deps.logger.info('restart_requested', {});
    setTimeout(() => { this.onRestartRequested?.(); }, 500).unref();
    return 'Restarting: a running task checkpoints at its next safe point and is re-queued; systemd starts the service again.';
  }
}

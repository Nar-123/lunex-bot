import { runAgentLoop } from '../agent/agentLoop';
import type { AgentOutcome, ControlSignal } from '../agent/agentLoop';
import { findForbiddenChanges, findStrategySensitiveChanges } from '../agent/strategyGuard';
import { AgentTools } from '../agent/tools';
import type { CommandRunner } from '../commandRunner';
import type { GitOps } from '../gitOps';
import type { LlmClient } from '../llm/tokenRouterClient';
import type { Logger } from '../logger';
import type { ScopeGuard } from '../scopeGuard';
import type { Masker } from '../secretMask';
import type { StateStore, Task, TaskResult, TaskStatus } from '../stateStore';
import type { TaskQueue } from '../taskQueue';
import { formatStep, runVerification } from '../verification';
import type { VerificationReport } from '../verification';

export interface TaskRunnerDeps {
  store: StateStore;
  queue: TaskQueue;
  git: GitOps;
  runner: CommandRunner;
  guard: ScopeGuard;
  llm: LlmClient;
  logger: Logger;
  mask: Masker;
  integrationBranch: string;
  maxAgentSteps: number;
  maxDebugRounds: number;
  /** A task started this many times without reaching a terminal state is reported BLOCKED instead of looping forever. */
  maxAttempts?: number;
  control: () => ControlSignal;
  notify: (task: Task) => Promise<void>;
  verify?: () => Promise<VerificationReport>;
  now?: () => Date;
}

export interface TaskRunOutcome {
  task: Task;
  requeued: boolean;
  /** Stop picking up new work: the workspace needs a human before anything else runs. */
  pauseWorker: boolean;
  llmBackoff: boolean;
}

const NOT_RUN = 'NOT RUN (task did not reach supervisor verification)';

interface Preserved {
  commit: string | null;
  files: string[];
  problem: string | null;
}

/**
 * Runs ONE task: task -> inspect -> plan -> implement -> test -> debug ->
 * verify -> checkpoint -> report. Every git write happens here, never in the
 * model's hands, and only after these gates:
 *  1. supervisor verification passed (typecheck, lint, full tests, build);
 *  2. no forbidden path changed (supervisor code, .git, .ai, .github, .env);
 *  3. no secret-looking content in the added lines;
 *  4. strategy guard: strategy-sensitive files are committed on the task
 *     branch only and reported BLOCKED until the operator approves.
 * Unverified work is preserved as a WIP commit on its own task branch --
 * never merged, never discarded.
 */
export async function runTask(task: Task, deps: TaskRunnerDeps): Promise<TaskRunOutcome> {
  const now = deps.now ?? (() => new Date());
  const iso = (): string => now().toISOString();
  const maxAttempts = deps.maxAttempts ?? 3;
  let current: Task = { ...task, status: 'running', attempts: task.attempts + 1, result: null, updatedAt: iso() };

  const save = (): void => { deps.store.setCurrentTask(current); };
  const recordStep = (phase: string, note: string): void => {
    current = { ...current, updatedAt: iso(), steps: [...current.steps, { at: iso(), phase, note: deps.mask(note) }].slice(-200) };
    save();
  };
  const checkpoint = async (phase: string, note: string): Promise<void> => {
    let gitHead: string | null = null;
    let gitDirty: boolean | null = null;
    try {
      const snap = await deps.git.snapshot();
      gitHead = snap.head;
      gitDirty = snap.dirty;
    } catch {
      // checkpoint without git info rather than no checkpoint
    }
    deps.store.addCheckpoint({ taskId: current.id, phase, note: deps.mask(note), gitHead, gitDirty });
  };

  const finalize = async (status: TaskStatus, result: TaskResult | null, opts: { requeue?: boolean; pauseWorker?: boolean; llmBackoff?: boolean } = {}): Promise<TaskRunOutcome> => {
    current = { ...current, status, result, updatedAt: iso() };
    if (opts.requeue) {
      deps.queue.enqueue({ ...current, status: 'interrupted', result: null });
    } else if (status === 'completed') {
      deps.store.appendCompleted(current);
    } else {
      deps.store.appendBlocked(current);
    }
    deps.store.setCurrentTask(null);
    await checkpoint(opts.requeue ? 'requeued' : 'finish', `${current.id} -> ${opts.requeue ? 'requeued' : status}${result?.reason ? `: ${result.reason}` : ''}`);
    if (!opts.requeue) {
      try {
        await deps.notify(current);
      } catch (err) {
        deps.logger.error('report_send_failed', { taskId: current.id, message: err instanceof Error ? err.message : String(err) });
      }
    }
    deps.logger.info('task_finished', { taskId: current.id, status, requeued: opts.requeue ?? false });
    return { task: current, requeued: opts.requeue ?? false, pauseWorker: opts.pauseWorker ?? false, llmBackoff: opts.llmBackoff ?? false };
  };

  const result = (status: TaskResult['status'], fields: Partial<TaskResult>): TaskResult => ({
    status,
    rootCause: fields.rootCause ?? '',
    changes: fields.changes ?? [],
    tests: fields.tests ?? NOT_RUN,
    build: fields.build ?? NOT_RUN,
    git: fields.git ?? (current.branch ? `${current.branch} (no commit)` : 'no branch'),
    next: fields.next ?? '',
    ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
    ...(fields.requiredAction !== undefined ? { requiredAction: fields.requiredAction } : {}),
  });

  const preserveWork = async (message: string): Promise<Preserved> => {
    const snap = await deps.git.snapshot();
    if (!snap.dirty) return { commit: null, files: [], problem: null };
    await deps.git.stageAll();
    const files = await deps.git.stagedFiles();
    const forbidden = findForbiddenChanges(files);
    if (forbidden.length > 0) return { commit: null, files, problem: `forbidden paths changed: ${forbidden.join(', ')}` };
    const added = await deps.git.stagedAddedLines();
    if (deps.mask(added) !== added) return { commit: null, files, problem: 'staged changes contain secret-looking content (masking would alter them)' };
    return { commit: await deps.git.commitStaged(message), files, problem: null };
  };

  const preserveThen = async (label: string, onPreserved: (p: Preserved) => Promise<TaskRunOutcome>): Promise<TaskRunOutcome> => {
    const preserved = await preserveWork(`WIP [unverified] ${label}: ${current.title}\n\nLunex AI task ${current.id}. Not verified, not merged.`);
    if (preserved.problem) {
      return finalize('blocked', result('BLOCKED', {
        changes: preserved.files,
        reason: preserved.problem,
        requiredAction: 'Inspect the staged changes on the VPS workspace manually. The worker is paused; nothing was committed.',
      }), { pauseWorker: true });
    }
    return onPreserved(preserved);
  };

  try {
    save();
    recordStep('start', `attempt ${String(current.attempts)}`);
    await checkpoint('start', `task ${current.id} attempt ${String(current.attempts)}`);

    if (current.attempts > maxAttempts) {
      return await finalize('blocked', result('BLOCKED', {
        reason: `task was started ${String(current.attempts)} times without finishing (limit ${String(maxAttempts)})`,
        requiredAction: 'Re-scope the task or re-submit it with /task.',
      }));
    }

    // ---- branch -------------------------------------------------------
    if (current.branch && (await deps.git.branchExists(current.branch))) {
      const snap = await deps.git.snapshot();
      if (snap.branch !== current.branch) {
        if (snap.dirty) {
          return await finalize('blocked', result('BLOCKED', {
            reason: `cannot resume on ${current.branch}: uncommitted changes exist on ${snap.branch ?? '?'}`,
            requiredAction: 'Inspect git status in the workspace; the supervisor never discards work.',
          }), { pauseWorker: true });
        }
        await deps.git.checkout(current.branch);
      }
    } else {
      const branch = await deps.git.startTaskBranch(current.id, current.title, deps.integrationBranch);
      current = { ...current, branch };
      save();
    }
    recordStep('branch', current.branch ?? '?');

    // ---- agent --------------------------------------------------------
    const tools = new AgentTools({
      guard: deps.guard,
      runner: deps.runner,
      mask: deps.mask,
      onCheckpoint: (phase, note) => {
        void checkpoint(phase, note).catch(() => undefined);
      },
    });
    const outcome: AgentOutcome = await runAgentLoop(
      current,
      {
        git: await deps.git.snapshot().catch(() => null),
        branch: current.branch,
        recentCompleted: deps.store.getCompleted(10),
        recentBlocked: deps.store.getBlocked(10),
      },
      {
        llm: deps.llm,
        tools,
        logger: deps.logger,
        mask: deps.mask,
        maxSteps: deps.maxAgentSteps,
        maxDebugRounds: deps.maxDebugRounds,
        verify: deps.verify ?? (() => runVerification(deps.runner)),
        control: deps.control,
        recordStep,
      },
    );

    // ---- outcome ------------------------------------------------------
    switch (outcome.kind) {
      case 'finished': {
        if (outcome.status === 'COMPLETED' && outcome.verification) {
          const verification = outcome.verification;
          const tests = verification.steps.filter((s) => s.name === 'test').map(formatStep).join('\n');
          const build = verification.steps.filter((s) => s.name !== 'test').map(formatStep).join('\n');
          const preserved = await preserveWork(`${current.title}\n\nLunex AI task ${current.id} (${current.priority}).\n\nRoot cause: ${outcome.rootCause}\n\n${outcome.summary}\n\nVerified by the supervisor: typecheck, lint, full test suite, build.`);
          if (preserved.problem) {
            return await finalize('blocked', result('BLOCKED', { rootCause: outcome.rootCause, changes: preserved.files, tests, build, reason: preserved.problem, requiredAction: 'Inspect the staged changes manually. The worker is paused; nothing was committed.' }), { pauseWorker: true });
          }
          if (!preserved.commit) {
            return await finalize('completed', result('COMPLETED', { rootCause: outcome.rootCause, tests, build, git: `${current.branch ?? '?'} (no file changes)`, next: outcome.next }));
          }
          current = { ...current, commit: preserved.commit };
          const sensitive = findStrategySensitiveChanges(preserved.files);
          if (sensitive.length > 0 && !current.allowStrategyChange) {
            await deps.git.checkout(deps.integrationBranch);
            return await finalize('blocked', result('BLOCKED', {
              rootCause: outcome.rootCause,
              changes: preserved.files,
              tests,
              build,
              git: `${current.branch ?? '?'} @ ${preserved.commit.slice(0, 10)} (NOT merged into ${deps.integrationBranch})`,
              next: outcome.next,
              reason: `strategy-sensitive files changed without explicit permission: ${sensitive.join(', ')}`,
              requiredAction: `Review branch ${current.branch ?? '?'}. Send /approve ${current.id} to merge it, or leave it unmerged.`,
            }));
          }
          await deps.git.fastForward(deps.integrationBranch, current.branch ?? '');
          return await finalize('completed', result('COMPLETED', {
            rootCause: outcome.rootCause,
            changes: preserved.files,
            tests,
            build,
            git: `${current.branch ?? '?'} @ ${preserved.commit.slice(0, 10)} -> fast-forwarded into ${deps.integrationBranch} (not pushed)`,
            next: outcome.next,
          }));
        }
        const finishStatus = outcome.status === 'FAILED' ? 'failed' : 'blocked';
        return await preserveThen(outcome.status, (p) =>
          finalize(finishStatus, result(outcome.status === 'FAILED' ? 'FAILED' : 'BLOCKED', {
            rootCause: outcome.rootCause,
            changes: p.files,
            git: p.commit ? `${current.branch ?? '?'} @ ${p.commit.slice(0, 10)} (WIP, not merged)` : `${current.branch ?? '?'} (no changes)`,
            next: outcome.next,
            reason: outcome.reason ?? outcome.summary,
            requiredAction: outcome.requiredAction ?? 'Review the report and re-submit a clarified task if needed.',
          })));
      }
      case 'verification_failed': {
        const tests = outcome.verification.steps.filter((s) => s.name === 'test').map(formatStep).join('\n') || 'NOT RUN';
        const build = outcome.verification.steps.filter((s) => s.name !== 'test').map(formatStep).join('\n');
        return await preserveThen('verification failed', (p) =>
          finalize('failed', result('FAILED', {
            rootCause: outcome.rootCause,
            changes: p.files,
            tests,
            build,
            git: p.commit ? `${current.branch ?? '?'} @ ${p.commit.slice(0, 10)} (WIP, not merged)` : current.branch ?? '?',
            reason: `supervisor verification still failing after ${String(deps.maxDebugRounds)} debug rounds`,
            requiredAction: 'Inspect the failing output on the task branch.',
          })));
      }
      case 'step_budget_exhausted':
        return await preserveThen('step budget exhausted', () => {
          recordStep('requeue', 'step budget exhausted; progress preserved on the task branch');
          return finalize('interrupted', null, { requeue: true });
        });
      case 'interrupted':
        return await preserveThen(`interrupted (${outcome.by})`, (p) => {
          if (outcome.by === 'pause') {
            recordStep('requeue', 'paused at a safe point; will resume on the task branch');
            return finalize('interrupted', null, { requeue: true });
          }
          return finalize('stopped', result('BLOCKED', {
            changes: p.files,
            git: p.commit ? `${current.branch ?? '?'} @ ${p.commit.slice(0, 10)} (WIP, not merged)` : current.branch ?? '?',
            reason: 'stopped by operator',
            requiredAction: 'Re-submit with /task, or /resume to continue with the queue.',
          }));
        });
      case 'llm_error':
        return await preserveThen('LLM error', () => {
          recordStep('llm_error', outcome.message);
          if (current.attempts < maxAttempts) return finalize('interrupted', null, { requeue: true, llmBackoff: true });
          return finalize('blocked', result('BLOCKED', {
            reason: `model gateway error: ${outcome.message}`,
            requiredAction: 'Check TOKENROUTER_API_KEY / TOKENROUTER_BASE_URL / LUNEX_AI_MODEL and TokenRouter availability, then /task again.',
          }), { llmBackoff: true });
        });
    }
  } catch (err) {
    const message = deps.mask(err instanceof Error ? err.message : String(err));
    deps.logger.error('task_runner_error', { taskId: current.id, message });
    return finalize('blocked', result('BLOCKED', {
      reason: `supervisor error: ${message}`,
      requiredAction: 'Inspect /log and the workspace git state. The worker is paused.',
    }), { pauseWorker: true });
  }
}

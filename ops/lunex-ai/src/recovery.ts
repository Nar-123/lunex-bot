import type { GitSnapshot } from './gitOps';
import type { Logger } from './logger';
import type { StateStore, Task } from './stateStore';
import type { TaskQueue } from './taskQueue';

export interface RecoveryDeps {
  store: StateStore;
  queue: TaskQueue;
  snapshotGit: () => Promise<GitSnapshot>;
  logger: Logger;
  now?: () => Date;
  /** Removes git lock files left by a killed git command -- see gitLock.ts. Runs before any git read. */
  clearStaleGitLocks?: () => { action: 'none' | 'removed' | 'kept'; detail: string };
}

export interface RecoveryOutcome {
  recoveredTask: Task | null;
  git: GitSnapshot | null;
  note: string;
}

/**
 * Runs once at startup, before the worker or Telegram polling starts.
 *
 * The one rule: an interrupted task is NEVER assumed to have completed.
 * A task found `running` in `current_task.json` means the process died
 * mid-task. It is marked `interrupted`, annotated with the git state found
 * now (branch, HEAD, uncommitted files), and put back in the queue with its
 * original priority and createdAt. Its branch is kept, so the agent resumes
 * on top of whatever it had already written, and the supervisor re-runs the
 * full verification gate before anything is committed.
 */
export async function recoverOnStartup(deps: RecoveryDeps): Promise<RecoveryOutcome> {
  const now = deps.now ?? (() => new Date());
  let lockNote = '';
  if (deps.clearStaleGitLocks) {
    try {
      const lock = deps.clearStaleGitLocks();
      if (lock.action !== 'none') {
        lockNote = `; git lock ${lock.action}: ${lock.detail}`;
        deps.logger.warn('stale_git_lock', { action: lock.action, detail: lock.detail });
      }
    } catch (err) {
      deps.logger.warn('stale_git_lock_check_failed', { message: err instanceof Error ? err.message : String(err) });
    }
  }
  let git: GitSnapshot | null = null;
  try {
    git = await deps.snapshotGit();
  } catch (err) {
    deps.logger.warn('recovery_git_snapshot_failed', { message: err instanceof Error ? err.message : String(err) });
  }

  deps.store.updateProgress({ stopRequested: false, startedAt: now().toISOString(), lastHeartbeatAt: now().toISOString() });

  const current = deps.store.getCurrentTask();
  if (!current) {
    const note = `no task was in flight${lockNote}`;
    deps.store.addCheckpoint({ taskId: null, phase: 'startup', note, gitHead: git?.head ?? null, gitDirty: git?.dirty ?? null });
    return { recoveredTask: null, git, note };
  }

  if (current.status !== 'running') {
    // Crashed after a terminal state was written but before current_task was cleared.
    const alreadyRecorded =
      current.status === 'completed'
        ? deps.store.getCompleted(200).some((t) => t.id === current.id)
        : deps.store.getBlocked(200).some((t) => t.id === current.id);
    if (!alreadyRecorded) {
      if (current.status === 'completed') deps.store.appendCompleted(current);
      else deps.store.appendBlocked(current);
    }
    deps.store.setCurrentTask(null);
    const note = `task ${current.id} was already ${current.status}; history reconciled${lockNote}`;
    deps.store.addCheckpoint({ taskId: current.id, phase: 'startup', note, gitHead: git?.head ?? null, gitDirty: git?.dirty ?? null });
    return { recoveredTask: null, git, note };
  }

  const lastStep = current.steps[current.steps.length - 1];
  const gitNote = git
    ? `branch=${git.branch ?? '?'} head=${git.head?.slice(0, 10) ?? '?'} uncommitted=${String(git.changedFiles.length)}`
    : 'git state unavailable';
  const note = `process restarted while task was running (last step: ${lastStep ? `${lastStep.phase}: ${lastStep.note}` : 'none'}); ${gitNote}; completion NOT assumed -- re-queued${lockNote}`;

  const interrupted: Task = {
    ...current,
    status: 'interrupted',
    updatedAt: now().toISOString(),
    steps: [...current.steps, { at: now().toISOString(), phase: 'recovery', note }],
  };
  const requeued = deps.queue.enqueue(interrupted);
  deps.store.setCurrentTask(null);
  deps.store.addCheckpoint({ taskId: current.id, phase: 'recovery', note, gitHead: git?.head ?? null, gitDirty: git?.dirty ?? null });
  deps.logger.warn('task_recovered_after_restart', { taskId: current.id, gitNote });
  return { recoveredTask: requeued, git, note };
}

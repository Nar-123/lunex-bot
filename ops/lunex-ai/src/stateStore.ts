import fs from 'node:fs';
import path from 'node:path';

export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
export const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4'];

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'interrupted' | 'stopped';
export type TaskSource = 'telegram-command' | 'telegram-natural' | 'autonomous' | 'recovery';

export interface TaskStep {
  at: string;
  phase: string;
  note: string;
}

export interface TaskResult {
  status: 'COMPLETED' | 'FAILED' | 'BLOCKED';
  rootCause: string;
  changes: string[];
  tests: string;
  build: string;
  git: string;
  next: string;
  reason?: string;
  requiredAction?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  source: TaskSource;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  /** Number of times a worker has started this task (a recovered task keeps counting). */
  attempts: number;
  branch: string | null;
  commit: string | null;
  steps: TaskStep[];
  result: TaskResult | null;
  /** Only an explicit operator instruction may set this -- see agent strategy guard. */
  allowStrategyChange: boolean;
}

export interface Checkpoint {
  at: string;
  taskId: string | null;
  phase: string;
  note: string;
  gitHead: string | null;
  gitDirty: boolean | null;
}

export interface Progress {
  paused: boolean;
  stopRequested: boolean;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastIdleTaskAt: string | null;
  selfTasks: { date: string; count: number };
  /** Next Telegram update_id to request -- persisted so a restart never re-executes an already-handled command. */
  telegramOffset: number;
}

const MAX_CHECKPOINTS = 500;
const MAX_HISTORY = 200;

export const DEFAULT_PROGRESS: Progress = {
  paused: false,
  stopRequested: false,
  startedAt: null,
  lastHeartbeatAt: null,
  lastIdleTaskAt: null,
  selfTasks: { date: '', count: 0 },
  telegramOffset: 0,
};

/**
 * Persistent supervisor state under `.ai/state/`, one JSON file per concern
 * (current_task, queue, progress, checkpoints, completed, blocked).
 *
 * Writes are atomic (temp file + rename in the same directory), so a crash
 * or power loss mid-write leaves either the old or the new file, never a
 * torn one. A file that is nevertheless unparseable is moved aside as
 * `<name>.corrupt-<timestamp>` and replaced by its empty default -- the
 * supervisor keeps running and the evidence is preserved for inspection.
 */
export class StateStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly onCorrupt: (file: string, movedTo: string) => void = () => undefined,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }

  private read<T>(name: string, fallback: T): T {
    const file = this.file(name);
    if (!fs.existsSync(file)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      const movedTo = `${file}.corrupt-${this.now().getTime()}`;
      try {
        fs.renameSync(file, movedTo);
      } catch {
        // leave it; the next write replaces it atomically anyway
      }
      this.onCorrupt(file, movedTo);
      return fallback;
    }
  }

  private write(name: string, value: unknown): void {
    const file = this.file(name);
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w', 0o640);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  getCurrentTask(): Task | null {
    return this.read<Task | null>('current_task', null);
  }

  setCurrentTask(task: Task | null): void {
    this.write('current_task', task);
  }

  getQueue(): Task[] {
    return this.read<Task[]>('queue', []);
  }

  setQueue(tasks: Task[]): void {
    this.write('queue', tasks);
  }

  getProgress(): Progress {
    return { ...DEFAULT_PROGRESS, ...this.read<Partial<Progress>>('progress', {}) };
  }

  updateProgress(patch: Partial<Progress>): Progress {
    const next = { ...this.getProgress(), ...patch };
    this.write('progress', next);
    return next;
  }

  addCheckpoint(checkpoint: Omit<Checkpoint, 'at'>): Checkpoint {
    const full: Checkpoint = { at: this.now().toISOString(), ...checkpoint };
    const all = this.read<Checkpoint[]>('checkpoints', []);
    all.push(full);
    this.write('checkpoints', all.slice(-MAX_CHECKPOINTS));
    return full;
  }

  getCheckpoints(limit = 20): Checkpoint[] {
    return this.read<Checkpoint[]>('checkpoints', []).slice(-limit);
  }

  appendCompleted(task: Task): void {
    const all = this.read<Task[]>('completed', []);
    all.push(task);
    this.write('completed', all.slice(-MAX_HISTORY));
  }

  getCompleted(limit = 20): Task[] {
    return this.read<Task[]>('completed', []).slice(-limit);
  }

  appendBlocked(task: Task): void {
    const all = this.read<Task[]>('blocked', []);
    all.push(task);
    this.write('blocked', all.slice(-MAX_HISTORY));
  }

  getBlocked(limit = 20): Task[] {
    return this.read<Task[]>('blocked', []).slice(-limit);
  }
}

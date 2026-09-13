import { randomBytes } from 'node:crypto';
import { PRIORITIES } from './stateStore';
import type { Priority, StateStore, Task, TaskSource } from './stateStore';

export interface NewTaskInput {
  title: string;
  description: string;
  priority: Priority;
  source: TaskSource;
  allowStrategyChange?: boolean;
}

export function createTask(input: NewTaskInput, now: Date = new Date(), id?: string): Task {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const iso = now.toISOString();
  return {
    id: id ?? `T-${stamp}-${randomBytes(2).toString('hex')}`,
    title: input.title.slice(0, 200),
    description: input.description,
    priority: input.priority,
    source: input.source,
    status: 'queued',
    createdAt: iso,
    updatedAt: iso,
    attempts: 0,
    branch: null,
    commit: null,
    steps: [],
    result: null,
    allowStrategyChange: input.allowStrategyChange ?? false,
  };
}

function compare(a: Task, b: Task): number {
  const byPriority = PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority);
  return byPriority !== 0 ? byPriority : a.createdAt.localeCompare(b.createdAt);
}

/**
 * Persistent priority queue: P0 before P4, oldest first within a priority.
 * An interrupted task keeps its original `createdAt`, so after recovery it
 * naturally runs before newer work of the same priority. Low-value cleanup
 * can never starve a critical bug.
 */
export class TaskQueue {
  constructor(private readonly store: StateStore) {}

  list(): Task[] {
    return [...this.store.getQueue()].sort(compare);
  }

  enqueue(task: Task): Task {
    const queued: Task = { ...task, status: 'queued' };
    const tasks = this.store.getQueue().filter((t) => t.id !== task.id);
    tasks.push(queued);
    this.store.setQueue(tasks.sort(compare));
    return queued;
  }

  /** Removes and returns the highest-priority task, or null. */
  dequeueNext(): Task | null {
    const tasks = this.list();
    const next = tasks.shift() ?? null;
    if (next) this.store.setQueue(tasks);
    return next;
  }

  /** Clears QUEUED tasks only; a running task is never touched by this. Returns how many were removed. */
  clear(): number {
    const count = this.store.getQueue().length;
    this.store.setQueue([]);
    return count;
  }

  size(): number {
    return this.store.getQueue().length;
  }
}

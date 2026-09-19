import type { DecisionStatePatch, ExitStateFields, ExitStateRecord, ExitStateRepository, SwapLegBlockReason, SwapLegPatch } from '../../src/exits/types';
import { EMPTY_EXIT_STATE, assertMonotonicDecisionPatch } from '../../src/exits/types';

/**
 * In-memory test double, same role as every other module's -- fast, no DB,
 * restart-simulation done by constructing a fresh repository seeded with a
 * specific record (see exitStateRepository persistence tests).
 *
 * Mirrors the real repository's stale-writer semantics exactly: every
 * write bumps `version`, `updateDecisionState` is a compare-and-swap on it
 * (plus the monotonic-field guard), and the counter / swap-leg writes are
 * conditional on `swapAttemptCount`. Every read returns a COPY, like the
 * real repository (a fresh object per query) -- so a caller's snapshot
 * never silently tracks another writer's changes.
 */
export class InMemoryExitStateRepository implements ExitStateRepository {
  private byPositionId = new Map<string, ExitStateRecord>();

  /** Test helper: seed a record directly, as if it had been read back after a restart. `version` defaults to 1. */
  seed(record: Omit<ExitStateRecord, 'version'> & { version?: number }): void {
    this.byPositionId.set(record.positionId, { version: 1, ...record });
  }

  async getOrCreate(positionId: string): Promise<ExitStateRecord> {
    let record = this.byPositionId.get(positionId);
    if (!record) {
      record = { positionId, ...EMPTY_EXIT_STATE, version: 1 };
      this.byPositionId.set(positionId, record);
    }
    return { ...record };
  }

  async updateDecisionState(positionId: string, expectedVersion: number, patch: DecisionStatePatch): Promise<ExitStateRecord | null> {
    const current = this.byPositionId.get(positionId);
    if (!current || current.version !== expectedVersion) return null;
    assertMonotonicDecisionPatch(positionId, current, patch);
    const updated: ExitStateRecord = { ...current, ...patch, version: current.version + 1 };
    this.byPositionId.set(positionId, updated);
    return { ...updated };
  }

  async incrementSwapAttemptFrom(positionId: string, expectedCount: number): Promise<boolean> {
    const current = this.byPositionId.get(positionId);
    if (!current || current.swapAttemptCount !== expectedCount) return false;
    this.byPositionId.set(positionId, { ...current, swapAttemptCount: current.swapAttemptCount + 1, version: current.version + 1 });
    return true;
  }

  async updateSwapLegFields(positionId: string, expectedSwapAttemptCount: number, patch: SwapLegPatch): Promise<boolean> {
    const current = this.byPositionId.get(positionId);
    if (!current || current.swapAttemptCount !== expectedSwapAttemptCount) return false;
    this.byPositionId.set(positionId, { ...current, ...patch, version: current.version + 1 });
    return true;
  }

  async recordSwapLegBlocked(positionId: string, expectedSwapAttemptCount: number, reason: SwapLegBlockReason, at: Date): Promise<'NEW' | 'UNCHANGED' | 'STALE'> {
    const current = this.byPositionId.get(positionId);
    if (!current || current.swapAttemptCount !== expectedSwapAttemptCount) return 'STALE';
    const wasReason = current.swapLegBlockedReason ?? null;
    this.byPositionId.set(positionId, {
      ...current,
      swapLegBlockedReason: reason,
      swapLegBlockedSince: current.swapLegBlockedSince ?? at,
      swapLegLastCheckedAt: at,
      version: wasReason === reason ? current.version : current.version + 1, // mirrors Prisma: only the reason transition bumps
    });
    return wasReason === reason ? 'UNCHANGED' : 'NEW';
  }

  async clearSwapLegBlocked(positionId: string, expectedSwapAttemptCount: number): Promise<void> {
    const current = this.byPositionId.get(positionId);
    if (!current || current.swapAttemptCount !== expectedSwapAttemptCount || (current.swapLegBlockedReason ?? null) === null) return;
    this.byPositionId.set(positionId, { ...current, swapLegBlockedReason: null, swapLegBlockedSince: null, swapLegLastCheckedAt: null, version: current.version + 1 });
  }

  /**
   * TEST-SETUP HELPER ONLY -- NOT part of `ExitStateRepository`: an
   * unconditional merge (bumps `version`), for arranging a scenario. The
   * production code can no longer perform an unconditional write.
   */
  async update(positionId: string, patch: Partial<ExitStateFields>): Promise<ExitStateRecord> {
    const existing = await this.getOrCreate(positionId);
    const updated: ExitStateRecord = { ...existing, ...patch, version: existing.version + 1 };
    this.byPositionId.set(positionId, updated);
    return { ...updated };
  }

  async findStuckSwapRetries(threshold: number): Promise<string[]> {
    return [...this.byPositionId.values()].filter((r) => r.swapAttemptCount >= threshold).map((r) => r.positionId);
  }
}

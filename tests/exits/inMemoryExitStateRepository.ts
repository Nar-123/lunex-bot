import type { ExitStateFields, ExitStateRecord, ExitStateRepository } from '../../src/exits/types';
import { EMPTY_EXIT_STATE } from '../../src/exits/types';

/** In-memory test double, same role as every other module's -- fast, no DB, restart-simulation done by constructing a fresh repository seeded with a specific record (see exitStateRepository persistence tests). */
export class InMemoryExitStateRepository implements ExitStateRepository {
  private byPositionId = new Map<string, ExitStateRecord>();

  /** Test helper: seed a record directly, as if it had been read back after a restart. */
  seed(record: ExitStateRecord): void {
    this.byPositionId.set(record.positionId, { ...record });
  }

  async getOrCreate(positionId: string): Promise<ExitStateRecord> {
    let record = this.byPositionId.get(positionId);
    if (!record) {
      record = { positionId, ...EMPTY_EXIT_STATE };
      this.byPositionId.set(positionId, record);
    }
    return { ...record };
  }

  async update(positionId: string, patch: Partial<ExitStateFields>): Promise<ExitStateRecord> {
    const existing = await this.getOrCreate(positionId);
    const updated: ExitStateRecord = { ...existing, ...patch };
    this.byPositionId.set(positionId, updated);
    return { ...updated };
  }

  async incrementSwapAttempt(positionId: string): Promise<ExitStateRecord> {
    const existing = await this.getOrCreate(positionId);
    const updated: ExitStateRecord = { ...existing, swapAttemptCount: existing.swapAttemptCount + 1 };
    this.byPositionId.set(positionId, updated);
    return { ...updated };
  }

  async findStuckSwapRetries(threshold: number): Promise<string[]> {
    return [...this.byPositionId.values()].filter((r) => r.swapAttemptCount >= threshold).map((r) => r.positionId);
  }
}

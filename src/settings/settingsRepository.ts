import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../storage/prismaClient';
import type { EntryState, EntryTransition, SettingsPatch, SettingsRecord, SettingsRepository } from './types';
import { DEFAULT_SETTINGS, toEntryState } from './types';

/** Single fixed id -- there is exactly one bot instance, so exactly one settings row ever exists. */
const SINGLETON_ID = 'singleton';

interface PrismaRow {
  id: string;
  paused: boolean;
  positionSizePct: number;
  maxActivePositions: number;
  hardStopLossPct: number;
  trailingTpTriggerPct: number;
  aiEntryPaused: boolean;
  aiEntryChangedAt: Date | null;
  aiEntryRequestId: string | null;
  updatedAt: Date;
}

function toRecord(row: PrismaRow): SettingsRecord {
  return {
    paused: row.paused,
    positionSizePct: row.positionSizePct,
    maxActivePositions: row.maxActivePositions,
    hardStopLossPct: row.hardStopLossPct,
    trailingTpTriggerPct: row.trailingTpTriggerPct,
    aiEntryPaused: row.aiEntryPaused,
    aiEntryChangedAt: row.aiEntryChangedAt,
    aiEntryRequestId: row.aiEntryRequestId,
    updatedAt: row.updatedAt,
  };
}

/**
 * Real, persistent (never in-memory-only) backing store for live-editable
 * bot parameters -- same singleton-row upsert pattern `ExitStateRepository`
 * uses per-position, applied here to one fixed row. `get()` upserting with
 * `DEFAULT_SETTINGS` on first call means behavior is byte-identical to the
 * pre-Module-10 frozen constants until an operator actually changes
 * something.
 */
export class PrismaSettingsRepository implements SettingsRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  async get(): Promise<SettingsRecord> {
    const row = await this.prisma.botSettings.upsert({
      where: { id: SINGLETON_ID },
      update: {},
      create: { id: SINGLETON_ID, ...DEFAULT_SETTINGS },
    });
    return toRecord(row);
  }

  async update(patch: SettingsPatch): Promise<SettingsRecord> {
    const row = await this.prisma.botSettings.upsert({
      where: { id: SINGLETON_ID },
      update: { ...patch },
      create: { id: SINGLETON_ID, ...DEFAULT_SETTINGS, ...patch },
    });
    return toRecord(row);
  }

  async pause(): Promise<SettingsRecord> {
    const row = await this.prisma.botSettings.upsert({
      where: { id: SINGLETON_ID },
      update: { paused: true },
      create: { id: SINGLETON_ID, ...DEFAULT_SETTINGS, paused: true },
    });
    return toRecord(row);
  }

  async resume(): Promise<SettingsRecord> {
    const row = await this.prisma.botSettings.upsert({
      where: { id: SINGLETON_ID },
      update: { paused: false },
      create: { id: SINGLETON_ID, ...DEFAULT_SETTINGS, paused: false },
    });
    return toRecord(row);
  }

  async getEntryState(): Promise<EntryState> {
    return toEntryState(await this.get());
  }

  async aiPauseEntry(requestId: string): Promise<EntryTransition> {
    return this.aiSetEntryPaused(true, requestId);
  }

  async aiResumeEntry(requestId: string): Promise<EntryTransition> {
    return this.aiSetEntryPaused(false, requestId);
  }

  /**
   * ONE conditional UPDATE (`WHERE aiEntryPaused = !target`) -- a
   * compare-and-set the database applies atomically, so concurrent
   * pause/resume calls serialize: no lost update, every call observes a
   * consistent before/after, and a repeated call is a no-op. It touches ONLY
   * the three AI entry columns (never the operator's `paused`, never a
   * strategy/risk setting). The write takes SQLite's write lock, so it is
   * linearizable with the capital-reservation transaction that re-reads the
   * flag under CapitalLock before every deployment.
   */
  private async aiSetEntryPaused(target: boolean, requestId: string): Promise<EntryTransition> {
    await this.get(); // make sure the singleton row exists
    return this.prisma.$transaction(async (tx) => {
      const moved = await tx.botSettings.updateMany({
        where: { id: SINGLETON_ID, aiEntryPaused: !target },
        data: { aiEntryPaused: target, aiEntryChangedAt: new Date(), aiEntryRequestId: requestId },
      });
      const after = toEntryState(toRecord(await tx.botSettings.findUniqueOrThrow({ where: { id: SINGLETON_ID } })));
      const changed = moved.count === 1;
      const previous: EntryState = changed
        ? { ...after, aiEntryPaused: !target, entryPaused: after.operatorPaused || !target }
        : after;
      return { changed, previous, current: after };
    });
  }
}

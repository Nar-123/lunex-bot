import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../storage/prismaClient';
import type { SettingsPatch, SettingsRecord, SettingsRepository } from './types';
import { DEFAULT_SETTINGS } from './types';

/** Single fixed id -- there is exactly one bot instance, so exactly one settings row ever exists. */
const SINGLETON_ID = 'singleton';

interface PrismaRow {
  id: string;
  paused: boolean;
  positionSizePct: number;
  maxActivePositions: number;
  hardStopLossPct: number;
  trailingTpTriggerPct: number;
  updatedAt: Date;
}

function toRecord(row: PrismaRow): SettingsRecord {
  return {
    paused: row.paused,
    positionSizePct: row.positionSizePct,
    maxActivePositions: row.maxActivePositions,
    hardStopLossPct: row.hardStopLossPct,
    trailingTpTriggerPct: row.trailingTpTriggerPct,
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
}

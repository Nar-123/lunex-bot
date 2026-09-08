import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../storage/prismaClient';
import type { ExitStateFields, ExitStateRecord, ExitStateRepository, ExitTriggerReason } from './types';
import { EMPTY_EXIT_STATE } from './types';

interface PrismaRow {
  positionId: string;
  trailingPeakPnlPct: number | null;
  drawdownConfirmStartedAt: Date | null;
  oorStartedAt: Date | null;
  pnlProtectionActivatedAt: Date | null;
  metricsFailureSince: Date | null;
  swapAttemptCount: number;
  swapUsdgBalanceBeforeRaw: string | null;
  swapMinOutputAmountRaw: string | null;
  pendingCloseReason: string | null;
}

/** Same BigInt-as-decimal-string convention as `positions/positionRepository.ts` -- SQLite's signed-INTEGER range overflows for routine 18-decimal USDG amounts. */
function toPrismaBigIntString(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function fromPrismaBigIntString(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function toRecord(row: PrismaRow): ExitStateRecord {
  return {
    positionId: row.positionId,
    trailingPeakPnlPct: row.trailingPeakPnlPct,
    drawdownConfirmStartedAt: row.drawdownConfirmStartedAt,
    oorStartedAt: row.oorStartedAt,
    pnlProtectionActivatedAt: row.pnlProtectionActivatedAt,
    metricsFailureSince: row.metricsFailureSince,
    swapAttemptCount: row.swapAttemptCount,
    swapUsdgBalanceBeforeRaw: fromPrismaBigIntString(row.swapUsdgBalanceBeforeRaw),
    swapMinOutputAmountRaw: fromPrismaBigIntString(row.swapMinOutputAmountRaw),
    pendingCloseReason: row.pendingCloseReason as ExitTriggerReason | null,
  };
}

function toPrismaPatch(patch: Partial<ExitStateFields>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch };
  if ('swapUsdgBalanceBeforeRaw' in patch) out.swapUsdgBalanceBeforeRaw = toPrismaBigIntString(patch.swapUsdgBalanceBeforeRaw ?? null);
  if ('swapMinOutputAmountRaw' in patch) out.swapMinOutputAmountRaw = toPrismaBigIntString(patch.swapMinOutputAmountRaw ?? null);
  return out;
}

/**
 * Real implementation of `types.ts`'s `ExitStateRepository` -- backs
 * Trailing TP / OOR / PNL Protection / Safety-Exit-failure-streak /
 * swap-retry state with real Prisma storage, per the explicit "must survive
 * a restart mid-countdown" requirement (spec, reiterated in review before
 * this module started). Mirrors `positions/positionRepository.ts`'s
 * structure and `TokenCooldown`'s standalone-table style.
 */
const EMPTY_EXIT_STATE_PRISMA = toPrismaPatch(EMPTY_EXIT_STATE);

export class PrismaExitStateRepository implements ExitStateRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  async getOrCreate(positionId: string): Promise<ExitStateRecord> {
    const row = await this.prisma.exitState.upsert({
      where: { positionId },
      update: {},
      create: { positionId, ...EMPTY_EXIT_STATE_PRISMA },
    });
    return toRecord(row);
  }

  async update(positionId: string, patch: Partial<ExitStateFields>): Promise<ExitStateRecord> {
    const prismaPatch = toPrismaPatch(patch);
    const row = await this.prisma.exitState.upsert({
      where: { positionId },
      update: prismaPatch,
      create: { positionId, ...EMPTY_EXIT_STATE_PRISMA, ...prismaPatch },
    });
    return toRecord(row);
  }

  async incrementSwapAttempt(positionId: string): Promise<ExitStateRecord> {
    const row = await this.prisma.exitState.upsert({
      where: { positionId },
      update: { swapAttemptCount: { increment: 1 } },
      create: { positionId, ...EMPTY_EXIT_STATE_PRISMA, swapAttemptCount: 1 },
    });
    return toRecord(row);
  }

  async findStuckSwapRetries(threshold: number): Promise<string[]> {
    const rows = await this.prisma.exitState.findMany({
      where: { swapAttemptCount: { gte: threshold } },
      select: { positionId: true },
    });
    return rows.map((r) => r.positionId);
  }
}

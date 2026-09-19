import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../storage/prismaClient';
import type { DecisionStatePatch, ExitStateFields, ExitStateRecord, ExitStateRepository, ExitTriggerReason, SwapLegBlockReason, SwapLegPatch } from './types';
import { EMPTY_EXIT_STATE, assertMonotonicDecisionPatch } from './types';

interface PrismaRow {
  positionId: string;
  trailingPeakPnlPct: number | null;
  drawdownConfirmStartedAt: Date | null;
  oorStartedAt: Date | null;
  safetyExitArmedAt: Date | null;
  maxDrawdownPnlPct: number | null;
  metricsFailureSince: Date | null;
  swapAttemptCount: number;
  swapUsdgBalanceBeforeRaw: string | null;
  swapMinOutputAmountRaw: string | null;
  swapVerifiedUsdgIncreaseRaw: string | null;
  pendingCloseReason: string | null;
  version: number;
  swapLegBlockedReason: string | null;
  swapLegBlockedSince: Date | null;
  swapLegLastCheckedAt: Date | null;
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
    safetyExitArmedAt: row.safetyExitArmedAt,
    maxDrawdownPnlPct: row.maxDrawdownPnlPct,
    metricsFailureSince: row.metricsFailureSince,
    swapAttemptCount: row.swapAttemptCount,
    swapUsdgBalanceBeforeRaw: fromPrismaBigIntString(row.swapUsdgBalanceBeforeRaw),
    swapMinOutputAmountRaw: fromPrismaBigIntString(row.swapMinOutputAmountRaw),
    swapVerifiedUsdgIncreaseRaw: fromPrismaBigIntString(row.swapVerifiedUsdgIncreaseRaw),
    pendingCloseReason: row.pendingCloseReason as ExitTriggerReason | null,
    version: row.version,
    swapLegBlockedReason: row.swapLegBlockedReason as SwapLegBlockReason | null,
    swapLegBlockedSince: row.swapLegBlockedSince,
    swapLegLastCheckedAt: row.swapLegLastCheckedAt,
  };
}

function toPrismaPatch(patch: Partial<ExitStateFields>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch };
  if ('swapUsdgBalanceBeforeRaw' in patch) out.swapUsdgBalanceBeforeRaw = toPrismaBigIntString(patch.swapUsdgBalanceBeforeRaw ?? null);
  if ('swapMinOutputAmountRaw' in patch) out.swapMinOutputAmountRaw = toPrismaBigIntString(patch.swapMinOutputAmountRaw ?? null);
  if ('swapVerifiedUsdgIncreaseRaw' in patch) out.swapVerifiedUsdgIncreaseRaw = toPrismaBigIntString(patch.swapVerifiedUsdgIncreaseRaw ?? null);
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

  /**
   * Stale-writer fix. The check below reads the row at `expectedVersion`
   * only to validate monotonicity; the WRITE itself is a single conditional
   * UPDATE (`WHERE positionId = ? AND version = ?`), so if any other writer
   * commits in between, it matches zero rows and nothing is written -- the
   * database, not this process, decides who wins.
   */
  async updateDecisionState(positionId: string, expectedVersion: number, patch: DecisionStatePatch): Promise<ExitStateRecord | null> {
    const current = await this.prisma.exitState.findUnique({ where: { positionId } });
    if (!current || current.version !== expectedVersion) return null;
    assertMonotonicDecisionPatch(positionId, toRecord(current), patch);
    const result = await this.prisma.exitState.updateMany({
      where: { positionId, version: expectedVersion },
      data: { ...toPrismaPatch(patch), version: { increment: 1 } },
    });
    if (result.count !== 1) return null;
    return toRecord(await this.prisma.exitState.findUniqueOrThrow({ where: { positionId } }));
  }

  async incrementSwapAttemptFrom(positionId: string, expectedCount: number): Promise<boolean> {
    const result = await this.prisma.exitState.updateMany({
      where: { positionId, swapAttemptCount: expectedCount },
      data: { swapAttemptCount: { increment: 1 }, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  async updateSwapLegFields(positionId: string, expectedSwapAttemptCount: number, patch: SwapLegPatch): Promise<boolean> {
    const result = await this.prisma.exitState.updateMany({
      where: { positionId, swapAttemptCount: expectedSwapAttemptCount },
      data: { ...toPrismaPatch(patch), version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /**
   * Two statements, each a single conditional UPDATE on the current attempt
   * number (so a stale worker on an older attempt writes nothing): the
   * first stamps `swapLegBlockedSince` only if it is still null (set once
   * per continuous block, never moved), the second refreshes reason and
   * last-checked. Both are idempotent, so concurrent callers converge.
   */
  async recordSwapLegBlocked(positionId: string, expectedSwapAttemptCount: number, reason: SwapLegBlockReason, at: Date): Promise<'NEW' | 'UNCHANGED' | 'STALE'> {
    // Each step is ONE conditional UPDATE (atomic in SQLite), so concurrent
    // workers / processes cannot both observe the transition: exactly one
    // gets NEW (and logs), the rest UNCHANGED; a worker on an older swap
    // attempt matches no row and gets STALE.
    await this.prisma.exitState.updateMany({
      where: { positionId, swapAttemptCount: expectedSwapAttemptCount, swapLegBlockedSince: null },
      data: { swapLegBlockedSince: at },
    });
    const transitioned = await this.prisma.exitState.updateMany({
      where: { positionId, swapAttemptCount: expectedSwapAttemptCount, OR: [{ swapLegBlockedReason: null }, { NOT: { swapLegBlockedReason: reason } }] },
      data: { swapLegBlockedReason: reason, swapLegLastCheckedAt: at, version: { increment: 1 } },
    });
    if (transitioned.count === 1) return 'NEW';
    const refreshed = await this.prisma.exitState.updateMany({
      where: { positionId, swapAttemptCount: expectedSwapAttemptCount, swapLegBlockedReason: reason },
      data: { swapLegLastCheckedAt: at },
    });
    return refreshed.count === 1 ? 'UNCHANGED' : 'STALE';
  }

  async clearSwapLegBlocked(positionId: string, expectedSwapAttemptCount: number): Promise<void> {
    await this.prisma.exitState.updateMany({
      where: { positionId, swapAttemptCount: expectedSwapAttemptCount, NOT: { swapLegBlockedReason: null } },
      data: { swapLegBlockedReason: null, swapLegBlockedSince: null, swapLegLastCheckedAt: null, version: { increment: 1 } },
    });
  }

  async findStuckSwapRetries(threshold: number): Promise<string[]> {
    const rows = await this.prisma.exitState.findMany({
      where: { swapAttemptCount: { gte: threshold } },
      select: { positionId: true },
    });
    return rows.map((r) => r.positionId);
  }
}

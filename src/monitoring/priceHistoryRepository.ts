import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../storage/prismaClient';
import type { PoolPriceSample, PriceHistoryProvider } from './types';

/**
 * TIER 3 — persistent rolling pool-price history, the data source for
 * Bollinger %B (`monitoring/bollinger.ts`) and therefore for the
 * OVEREXTENDED exit.
 *
 * Persistent rather than in-memory for the same reason every other timer
 * in `exits/` is (`oorStartedAt`, `drawdownConfirmStartedAt`): a restart
 * must not silently change a decision. A process that forgot its price
 * window would report %B as "unavailable" for a full 100 minutes
 * (20 x 5-minute closes) after every restart, quietly disabling the exit
 * Meridian measures as its best one.
 *
 * `price` is stored as a decimal STRING for the same reason
 * `Position.entryUsdgRaw` is -- not because these values overflow (they
 * don't; they are already down-scaled human prices) but because SQLite's
 * REAL is binary floating point and round-tripping a price through it
 * silently changes the last digits. A string round-trips exactly.
 */
export class PrismaPriceHistoryRepository implements PriceHistoryProvider {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  async recordSample(poolId: string, price: number, observedAt: Date = new Date()): Promise<void> {
    if (!Number.isFinite(price)) return; // never persist a non-price
    await this.prisma.poolPriceSample.create({
      data: { poolId, price: String(price), observedAt },
    });
  }

  async recentSamples(poolId: string, windowMs: number, now: Date = new Date()): Promise<PoolPriceSample[]> {
    const since = new Date(now.getTime() - windowMs);
    const rows = await this.prisma.poolPriceSample.findMany({
      where: { poolId, observedAt: { gte: since } },
      orderBy: { observedAt: 'asc' },
    });
    return rows
      .map((row) => ({ price: Number(row.price), observedAt: row.observedAt }))
      .filter((sample) => Number.isFinite(sample.price));
  }

  async pruneOlderThan(retentionMs: number, now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - retentionMs);
    await this.prisma.poolPriceSample.deleteMany({ where: { observedAt: { lt: cutoff } } });
  }
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPriceHistoryRepository } from '../../src/monitoring/priceHistoryRepository';
import { bucketSamplesToCloses, computePercentB } from '../../src/monitoring/bollinger';
import { config } from '../../src/config';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TEST_DB_PATH = path.resolve(PROJECT_ROOT, 'data', 'test-pricehistory-integration.db');
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

const POOL = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_POOL = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const T0 = new Date('2026-01-01T12:00:00.000Z');
const BUCKET_MS = config.rules.exits.OVEREXTENDED.BB_BUCKET_MS;
const PERIOD = config.rules.exits.OVEREXTENDED.BB_PERIOD;
const MULT = config.rules.exits.OVEREXTENDED.BB_STDDEV_MULTIPLIER;

function cleanupDbFiles(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = TEST_DB_PATH + suffix;
    if (existsSync(file)) rmSync(file);
  }
}

let prisma: PrismaClient;
let repo: PrismaPriceHistoryRepository;

beforeAll(() => {
  cleanupDbFiles();
  execSync('npx prisma migrate deploy', {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
  const adapter = new PrismaBetterSqlite3({ url: TEST_DB_URL });
  prisma = new PrismaClient({ adapter });
  repo = new PrismaPriceHistoryRepository(prisma);
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanupDbFiles();
});

describe('PrismaPriceHistoryRepository (real SQLite DB, real migration -- proves the TIER 3 migration actually applied)', () => {
  it('records a sample and reads it back within the window', async () => {
    await repo.recordSample(POOL, 1.2345, T0);
    const samples = await repo.recentSamples(POOL, 60_000, new Date(T0.getTime() + 1000));
    expect(samples).toHaveLength(1);
    expect(samples[0]?.price).toBe(1.2345);
    expect(samples[0]?.observedAt).toEqual(T0);
  });

  it('round-trips a long decimal price EXACTLY -- the reason price is stored as a string, not a SQLite REAL', async () => {
    const pool = `${POOL}-precision`;
    const price = 0.000012345678901234;
    await repo.recordSample(pool, price, T0);
    const [sample] = await repo.recentSamples(pool, 60_000, new Date(T0.getTime() + 1000));
    expect(sample?.price).toBe(price); // strict equality, not toBeCloseTo
  });

  it('returns samples OLDEST-FIRST -- bucketSamplesToCloses and computePercentB both depend on that ordering', async () => {
    const pool = `${POOL}-ordering`;
    // Inserted deliberately out of chronological order.
    await repo.recordSample(pool, 3, new Date(T0.getTime() + 2000));
    await repo.recordSample(pool, 1, new Date(T0.getTime()));
    await repo.recordSample(pool, 2, new Date(T0.getTime() + 1000));

    const samples = await repo.recentSamples(pool, 60_000, new Date(T0.getTime() + 10_000));
    expect(samples.map((s) => s.price)).toEqual([1, 2, 3]);
  });

  it('is keyed by POOL -- another pool\'s series never leaks into this one', async () => {
    const pool = `${POOL}-isolation`;
    await repo.recordSample(pool, 10, T0);
    await repo.recordSample(OTHER_POOL, 999, T0);

    const samples = await repo.recentSamples(pool, 60_000, new Date(T0.getTime() + 1000));
    expect(samples.map((s) => s.price)).toEqual([10]);
  });

  it('excludes samples older than the requested window, inclusive at the boundary', async () => {
    const pool = `${POOL}-window`;
    const now = new Date(T0.getTime() + 100_000);
    await repo.recordSample(pool, 1, new Date(now.getTime() - 60_001)); // just outside
    await repo.recordSample(pool, 2, new Date(now.getTime() - 60_000)); // exactly at the edge -> included (gte)
    await repo.recordSample(pool, 3, new Date(now.getTime() - 59_999)); // inside

    const samples = await repo.recentSamples(pool, 60_000, now);
    expect(samples.map((s) => s.price)).toEqual([2, 3]);
  });

  it('never persists a non-finite price -- a failed read is dropped, not stored as a number-shaped nothing', async () => {
    const pool = `${POOL}-nonfinite`;
    await repo.recordSample(pool, Number.NaN, T0);
    await repo.recordSample(pool, Number.POSITIVE_INFINITY, T0);
    expect(await repo.recentSamples(pool, 60_000, new Date(T0.getTime() + 1000))).toEqual([]);
  });

  it('pruneOlderThan drops only rows past the retention cutoff, leaving the live window intact', async () => {
    const pool = `${POOL}-prune`;
    const now = new Date(T0.getTime() + 1_000_000);
    await repo.recordSample(pool, 1, new Date(now.getTime() - 200_000)); // stale
    await repo.recordSample(pool, 2, new Date(now.getTime() - 50_000)); // fresh

    await repo.pruneOlderThan(100_000, now);

    const samples = await repo.recentSamples(pool, 10_000_000, now);
    expect(samples.map((s) => s.price)).toEqual([2]);
  });

  it('reads back empty (not an error) for a pool that has never been sampled -- which makes %B unavailable, never a fabricated reading', async () => {
    const samples = await repo.recentSamples('0xnever-sampled', 60_000, T0);
    expect(samples).toEqual([]);
    expect(computePercentB(bucketSamplesToCloses(samples, BUCKET_MS), PERIOD, MULT)).toBeNull();
  });

  it('END TO END: 20 five-minute buckets of persisted 15s polls survive a NEW repository instance and still yield a real %B -- the restart-survival requirement', async () => {
    const pool = `${POOL}-endtoend`;
    const start = new Date('2026-02-01T00:00:00.000Z');
    // Exactly the live cadence: one sample every 15 seconds for 100 minutes.
    for (let b = 0; b < PERIOD; b += 1) {
      for (let i = 0; i < 20; i += 1) {
        await repo.recordSample(pool, 100 + b * 0.5 + i * 0.001, new Date(start.getTime() + b * BUCKET_MS + i * 15_000));
      }
    }

    // A BRAND NEW repository instance -- nothing in memory carries over,
    // only what is actually in the database.
    const afterRestart = new PrismaPriceHistoryRepository(prisma);
    const now = new Date(start.getTime() + PERIOD * BUCKET_MS);
    const samples = await afterRestart.recentSamples(pool, PERIOD * BUCKET_MS + 1000, now);
    const closes = bucketSamplesToCloses(samples, BUCKET_MS);

    expect(closes).toHaveLength(PERIOD);
    const percentB = computePercentB(closes, PERIOD, MULT);
    expect(percentB).not.toBeNull();
    expect(Number.isFinite(percentB as number)).toBe(true);
  }, 30_000);
});

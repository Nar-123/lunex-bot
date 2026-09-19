// Stale-writer fix: a standalone worker run as a genuinely separate OS
// process (spawned by exitStateRepository.integration.test.ts) -- its own
// Node runtime, PrismaClient and driver adapter, sharing only the SQLite
// file. Performs ONE real repository write and prints its result as one
// JSON line.
//
// argv: [dbUrl, mode, ...args]
//   increment  <positionId> <expectedCount>                -> { applied: boolean }
//   decide     <positionId> <expectedVersion> <oorIso|null> -> { written: boolean }
//   markClosing <positionId> <closeKey>                     -> { won: boolean }
//   markClosed  <positionId> <closeKey> <closedAtIso>       -> { won: boolean }  (cooldown crash-gap fix: close + cooldown atomically)
//   block       <positionId> <expectedSwapCount> <reason>   -> { result: 'NEW'|'UNCHANGED'|'STALE' }  (unroutable TOKEN leg)
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaExitStateRepository } from '../../src/exits/exitStateRepository';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';

async function main(): Promise<void> {
  const [dbUrl, mode, a, b, c] = process.argv.slice(2) as [string, string, string, string, string | undefined];
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });
  try {
    let out: unknown;
    if (mode === 'increment') {
      out = { applied: await new PrismaExitStateRepository(prisma).incrementSwapAttemptFrom(a, Number(b)) };
    } else if (mode === 'decide') {
      const oorStartedAt = c === undefined || c === 'null' ? null : new Date(c);
      out = { written: (await new PrismaExitStateRepository(prisma).updateDecisionState(a, Number(b), { oorStartedAt })) !== null };
    } else if (mode === 'markClosing') {
      out = { won: (await new PrismaPositionRepository(prisma).markClosing(a, b)) !== null };
    } else if (mode === 'markClosed') {
      out = { won: (await new PrismaPositionRepository(prisma).markClosed(a, new Date(c as string), 'HARD_STOP_LOSS', 500n * 10n ** 18n, b)) !== null };
    } else if (mode === 'block') {
      out = { result: await new PrismaExitStateRepository(prisma).recordSwapLegBlocked(a, Number(b), c as 'QUOTE_UNAVAILABLE' | 'PRICE_IMPACT_BLOCKED', new Date()) };
    } else {
      throw new Error(`unknown mode ${mode}`);
    }
    process.stdout.write(JSON.stringify(out) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ threw: err instanceof Error ? err.message : String(err) }) + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

void main();

// A standalone worker run as a genuinely separate OS process (spawned by
// nonceReservation.integration.test.ts) -- NOT imported or run in-process.
//
// This is what makes the cross-process nonce tests real rather than a test of
// an in-memory mutex: each invocation gets its own Node process, its own
// PrismaClient and its own adapter-level mutex, unaware of any other
// invocation's. `ExecutorMutex` cannot coordinate two of these at all -- only
// the database can, via the `NonceLock` write lock and the partial unique index
// on (executorAddress, nonce).
//
// Prints exactly one line of JSON as its LAST stdout line:
//   { nonce, adjustedBy, skipped }         on success
//   { threw: string, kind?: string }       on failure
//
// argv: [dbUrl, executorAddress, idempotencyKey, purpose, chainPendingNonce, startBarrierCount?]
//
// `startBarrierCount` (optional) makes the race deterministic: the worker waits
// until at least that many TransactionAttempt rows exist for this executor
// before attempting its reservation, so several processes arrive at the lock
// together instead of politely queueing.
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import Database from 'better-sqlite3';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import { NonceReservationUnavailableError } from '../../src/execution/types';

const BARRIER_TIMEOUT_MS = 60_000;

async function waitForAttemptCount(dbPath: string, executor: string, count: number): Promise<void> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const deadline = Date.now() + BARRIER_TIMEOUT_MS;
    const stmt = db.prepare('SELECT COUNT(*) AS n FROM "TransactionAttempt" WHERE "executorAddress" = ?');
    for (;;) {
      const row = stmt.get(executor) as { n: number };
      if (row.n >= count) return;
      if (Date.now() > deadline) throw new Error(`barrier timed out waiting for ${count} attempts (saw ${row.n})`);
      await new Promise((r) => setTimeout(r, 15));
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const [dbUrl, executorAddress, idempotencyKey, purpose, chainPendingNonceRaw, barrierRaw] = process.argv.slice(2);
  if (!dbUrl || !executorAddress || !idempotencyKey || !purpose || chainPendingNonceRaw === undefined) {
    throw new Error('usage: nonceReservationWorker <dbUrl> <executor> <key> <purpose> <chainPendingNonce> [barrier]');
  }
  const dbPath = dbUrl.replace(/^file:/, '');
  const adapter = new PrismaBetterSqlite3({ url: dbUrl });
  const prisma = new PrismaClient({ adapter });
  const repo = new PrismaTransactionAttemptRepository(prisma, executorAddress);
  try {
    const attempt = await repo.create(idempotencyKey, purpose);
    // Get to GAS_CHECKED, the status the pipeline holds when it reserves.
    const ready = await repo.update(attempt.id, { status: 'GAS_CHECKED' }, attempt.version);

    if (barrierRaw !== undefined) await waitForAttemptCount(dbPath, executorAddress.toLowerCase(), Number(barrierRaw));

    const reservation = await repo.reserveNonce({
      attemptId: ready.id,
      expectedVersion: ready.version,
      chainPendingNonce: Number(chainPendingNonceRaw),
    });
    process.stdout.write(
      `${JSON.stringify({ nonce: reservation.nonce, adjustedBy: reservation.adjustedBy, skipped: reservation.skipped })}\n`,
    );
  } catch (err) {
    const kind = err instanceof NonceReservationUnavailableError ? err.kind : undefined;
    process.stdout.write(`${JSON.stringify({ threw: err instanceof Error ? err.message : String(err), kind })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  process.stdout.write(`${JSON.stringify({ threw: err instanceof Error ? err.message : String(err) })}\n`);
  process.exit(1);
});

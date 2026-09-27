// A standalone worker run as a genuinely separate OS process (spawned by
// sameKeyRace.integration.test.ts) -- NOT imported or run in-process.
//
// It drives the REAL executeCriticalTransaction against a shared SQLite file
// using an idempotencyKey it shares with a sibling process. Nothing in-process
// coordinates the two: only the unique index on idempotencyKey decides which
// `create` wins, which is exactly the race under test.
//
// Every chain-facing step is a local stub -- no RPC, no key, no signing of
// anything real -- but the payload it "signs" is tagged with this worker's id so
// the test can prove only ONE payload was ever produced for the key.
//
// Prints exactly one line of JSON as its LAST stdout line:
//   { ok, status, id, nonce, txHash, signCalls, broadcastCalls }
//   { threw: string }
//
// argv: [dbUrl, executorAddress, idempotencyKey, workerId, chainPendingNonce, barrierCount?]
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import Database from 'better-sqlite3';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';

const BARRIER_TIMEOUT_MS = 60_000;
const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };

/** Waits until at least `count` processes have signalled readiness, so both hit `create` together. */
async function barrier(dbPath: string, count: number): Promise<void> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const deadline = Date.now() + BARRIER_TIMEOUT_MS;
    const stmt = db.prepare('SELECT COUNT(*) AS n FROM "NonceLock"');
    for (;;) {
      const row = stmt.get() as { n: number };
      if (row.n >= count) return;
      if (Date.now() > deadline) throw new Error(`barrier timed out (saw ${row.n} of ${count})`);
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const [dbUrl, executorAddress, key, workerId, chainNonceRaw, barrierRaw] = process.argv.slice(2);
  if (!dbUrl || !executorAddress || !key || !workerId || chainNonceRaw === undefined) {
    throw new Error('usage: sameKeyRaceWorker <dbUrl> <executor> <key> <workerId> <chainPendingNonce> [barrier]');
  }
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });
  const repo = new PrismaTransactionAttemptRepository(prisma, executorAddress);
  let signCalls = 0;
  let broadcastCalls = 0;
  try {
    if (barrierRaw !== undefined) {
      // Signal readiness by writing a row this worker owns, then wait for the peer.
      await prisma.nonceLock.upsert({
        where: { id: 'ready-' + workerId },
        create: { id: 'ready-' + workerId, touchedAt: new Date() },
        update: { touchedAt: new Date() },
      });
      await barrier(dbUrl.replace(/^file:/, ''), Number(barrierRaw));
    }

    const deps: TxSafetyDeps<{ worker: string }> = {
      buildTransaction: async () => TX,
      simulate: async () => ({ ok: true }),
      estimateGas: async () => 100_000n,
      getGasPrice: async () => 1n,
      checkGasAffordable: async () => ({ ok: true }),
      getNonce: async () => Number(chainNonceRaw),
      signTransaction: async (_tx, nonce) => {
        signCalls += 1;
        // Payload tagged with the worker id: two payloads for one key would be
        // visible as two different hashes in the single persisted row.
        const tag = Buffer.from(`${workerId}:${nonce}`).toString('hex').padEnd(64, '0').slice(0, 64);
        return { raw: ('0x' + tag) as `0x${string}`, hash: ('0x' + tag) as `0x${string}` };
      },
      broadcastRaw: async () => {
        broadcastCalls += 1;
      },
      waitForReceipt: async () => ({ status: 'success' as const, blockNumber: 1n }),
      getReceiptIfAvailable: async () => null,
      verifyOnChain: async () => ({ ok: true as const, data: { worker: workerId } }),
    };

    const result = await executeCriticalTransaction(key, 'same-key-race', deps, repo, { log: () => undefined });
    const row = await repo.find(key);
    process.stdout.write(
      `${JSON.stringify({
        ok: result.ok,
        reason: result.ok ? undefined : result.reason,
        status: row?.status,
        id: row?.id,
        nonce: row?.nonce,
        txHash: row?.txHash,
        signCalls,
        broadcastCalls,
      })}\n`,
    );
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ threw: err instanceof Error ? err.message : String(err), signCalls, broadcastCalls })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  process.stdout.write(`${JSON.stringify({ threw: err instanceof Error ? err.message : String(err) })}\n`);
  process.exit(1);
});

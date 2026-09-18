// P1-1: a standalone worker, run as a genuinely separate OS process (via
// `child_process.spawn` in positionRepository.integration.test.ts's
// cross-process tests) -- NOT imported or run in-process. This is what makes
// those tests a real test of "works across separate processes, not merely an
// in-memory mutex": each invocation gets its own Node process, its own
// PrismaClient, and its own independent `PrismaBetterSqlite3Adapter`
// in-process mutex, unaware of any other invocation's. Only a real SQLite
// file-level lock (the `CapitalLock` mechanism in positionRepository.ts)
// can coordinate two of these. Prints exactly one line of JSON to stdout as
// its LAST line: the `CreateIfCapitalAllowsResult`, or `{ threw: string }`
// if it throws.
//
// argv: [dbUrl, tokenAddress, entryUsdgRaw, openIdempotencyKey, onChainUsdgBalance, rulesJson, gateNonClosedCount?]
//
// `onChainUsdgBalance` is the RAW on-chain balance the injected reader
// returns (what `CapitalSnapshotProvider.readOnChainUsdgBalance` would
// read) -- never a pre-derived free balance.
//
// `gateNonClosedCount` (optional) reproduces the original P1-1 race
// deterministically: once `createIfCapitalAllows` calls the balance reader
// (i.e. AFTER it has taken its pre-lock row observation), the worker prints
// `READER_ENTERED` and then holds the balance read open until at least that
// many non-closed Position rows exist -- so other processes' reservations
// land strictly between this worker's balance read and its CapitalLock
// acquisition, the exact window the old stale-free-balance code
// double-counted.
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import Database from 'better-sqlite3';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';
import { makeCreateInput } from './fixtures';

const GATE_TIMEOUT_MS = 60_000;

async function waitForNonClosedCount(dbPath: string, count: number): Promise<void> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const deadline = Date.now() + GATE_TIMEOUT_MS;
    for (;;) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "Position" WHERE "status" IN ('OPENING','ACTIVE','CLOSING')`).get() as { n: number };
      if (row.n >= count) return;
      if (Date.now() > deadline) throw new Error(`gate timed out waiting for ${count} non-closed positions (saw ${row.n})`);
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 6 && args.length !== 7) throw new Error(`expected 6 or 7 args, got ${args.length}`);
  const [dbUrl, tokenAddress, entryUsdgRawStr, openIdempotencyKey, onChainBalanceStr, rulesJson, gateStr] = args as [string, string, string, string, string, string, string | undefined];
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });
  const repo = new PrismaPositionRepository(prisma);
  const onChainBalance = BigInt(onChainBalanceStr);
  const gate = gateStr === undefined ? null : Number(gateStr);
  const readOnChainUsdgBalance = async (): Promise<bigint> => {
    if (gate !== null) {
      process.stdout.write('READER_ENTERED\n');
      await waitForNonClosedCount(dbUrl.replace(/^file:/, ''), gate);
    }
    return onChainBalance;
  };
  try {
    const result = await repo.createIfCapitalAllows(
      makeCreateInput({ tokenAddress: tokenAddress as `0x${string}`, entryUsdgRaw: BigInt(entryUsdgRawStr), openIdempotencyKey }),
      readOnChainUsdgBalance,
      JSON.parse(rulesJson),
    );
    process.stdout.write(JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ threw: err instanceof Error ? err.message : String(err) }) + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

void main();

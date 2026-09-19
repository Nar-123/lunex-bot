// Same-attempt swap race: a standalone worker run as a genuinely separate OS
// process (spawned by swapAttemptRace.integration.test.ts). It drives the REAL
// executeCriticalTransaction pipeline with the REAL buildSwapDeps
// (buildTransaction + verifyOnChain) against the REAL Prisma repositories;
// only chain/RPC steps are fakes. Prints one JSON result line.
//
// argv: [dbUrl, idempotencyKey, quoteTag A|B, pauseAt none|build|sign, receiptPaysWei]
// When paused, it prints `PAUSED` and waits (read-only DB polling, no sleeps
// between steps it controls) until the attempt reaches VERIFIED -- i.e. the
// OTHER worker has finished -- then continues.
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import Database from 'better-sqlite3';
import type { Address } from 'viem';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import { PrismaExitStateRepository } from '../../src/exits/exitStateRepository';
import { buildSwapDeps } from '../../src/exits/swapTx';
import type { SwapQuote } from '../../src/swap/types';

const U = 10n ** 18n;
const QUOTES: Record<string, SwapQuote> = {
  A: { amountInRaw: 10n * U, expectedAmountOutRaw: 950n * U, minOutputAmountRaw: 900n * U, priceImpactPct: 0.004, slippageBps: 100, providerQuote: {} },
  B: { amountInRaw: 10n * U, expectedAmountOutRaw: 840n * U, minOutputAmountRaw: 800n * U, priceImpactPct: 0.002, slippageBps: 100, providerQuote: {} },
};

async function waitUntilVerified(dbPath: string, key: string): Promise<void> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const row = db.prepare('SELECT status FROM "TransactionAttempt" WHERE "idempotencyKey" = ?').get(key) as { status: string } | undefined;
      if (row?.status === 'VERIFIED') return;
      if (Date.now() > deadline) throw new Error('gate timed out waiting for the other worker');
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const [dbUrl, key, tag, pauseAt, receiptPays] = process.argv.slice(2) as [string, string, 'A' | 'B', 'none' | 'build' | 'sign', string];
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });
  const calls = { buildSwapTx: 0, sign: 0, broadcast: 0 };
  const quote = QUOTES[tag]!;
  const park = async (step: string) => {
    if (pauseAt === step) {
      process.stdout.write('PAUSED\n');
      await waitUntilVerified(dbUrl.replace(/^file:/, ''), key);
    }
  };
  try {
    const exitStates = new PrismaExitStateRepository(prisma);
    await exitStates.getOrCreate('pos-proc');
    const real = buildSwapDeps(
      'pos-proc',
      '0x0000000000000000000000000000000000000002' as Address,
      quote,
      {
        getQuote: async () => quote,
        checkApproval: async () => ({ needsApproval: false, spender: null }),
        buildSwapTx: async () => {
          calls.buildSwapTx++;
          await park('build');
          return { to: '0x1111111111111111111111111111111111111111' as Address, data: `0x${quote.minOutputAmountRaw.toString(16)}` as `0x${string}`, value: 0n };
        },
      },
      exitStates,
      { swapAttemptCount: 0, readBalance: async () => 1000n * U, readUsdgTransfersTo: async () => BigInt(receiptPays), walletAddress: '0x9999999999999999999999999999999999999999' as Address },
    );
    const result = await executeCriticalTransaction(
      key,
      'exit:swap',
      {
        ...real,
        simulate: async () => ({ ok: true }) as const,
        estimateGas: async () => 100_000n,
        getGasPrice: async () => 1n,
        checkGasAffordable: async () => ({ ok: true }) as const,
        getNonce: async () => 7,
        signTransaction: async () => {
          calls.sign++;
          await park('sign');
          return { raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` };
        },
        broadcastRaw: async () => {
          calls.broadcast++;
        },
        waitForReceipt: async () => ({ status: 'success' as const, blockNumber: 1n }),
        getReceiptIfAvailable: async () => null,
      },
      new PrismaTransactionAttemptRepository(prisma),
    );
    process.stdout.write(JSON.stringify({ ok: result.ok, resumable: result.ok ? null : result.resumable, reason: result.ok ? null : result.reason, calls }) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ threw: err instanceof Error ? err.message : String(err), calls }) + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

void main();

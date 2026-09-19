// Manual TOKEN settlement via receipt: a standalone worker run as a
// genuinely separate OS process (spawned by
// manualTokenSettlement.integration.test.ts) -- its own Node runtime,
// PrismaClient and driver adapter, sharing only the SQLite file. Submits ONE
// settlement against a deterministic fake chain and prints the outcome as
// one JSON line.
//
// argv: [dbUrl, positionId, closeKey, wallet, token, usdg, chainId, residualRaw, usdgInRaw, claimMode]
//   claimMode 'claim'   -> the real resume claim (production behavior)
//   claimMode 'noclaim' -> claim forced to succeed, so both processes reach markClosed
import type { Address } from 'viem';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';
import { PrismaTransactionAttemptRepository } from '../../src/execution/transactionAttemptRepository';
import { PrismaExitStateRepository } from '../../src/exits/exitStateRepository';
import { settleResidualTokenViaReceipt } from '../../src/exits/manualTokenSettlement';
import { SETTLE_HASH, chainWithSettlement, swapLogs } from './settlementFixtures';

async function main(): Promise<void> {
  const [dbUrl, positionId, closeKey, wallet, token, usdg, chainId, residual, usdgIn, claimMode] = process.argv.slice(2) as string[] as [string, string, string, string, string, string, string, string, string, string];
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl, timeout: 10_000 }) });
  try {
    const positions = new PrismaPositionRepository(prisma);
    if (claimMode === 'noclaim') positions.claimForResume = async () => `forced-${process.pid}`;
    const s = { wallet, token, usdg, chainId: Number(chainId) };
    const result = await settleResidualTokenViaReceipt(
      {
        positions,
        txAttempts: new PrismaTransactionAttemptRepository(prisma),
        exitStates: new PrismaExitStateRepository(prisma),
        chain: chainWithSettlement(s, swapLogs(s, BigInt(residual), BigInt(usdgIn))),
        walletAddress: wallet as Address,
        usdgAddress: usdg as Address,
        chainId: Number(chainId),
      },
      { positionId, txHash: SETTLE_HASH, closeIdempotencyKey: closeKey },
    );
    process.stdout.write(JSON.stringify({ outcome: result.outcome, reason: result.outcome === 'REJECTED' ? result.reason : undefined }) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ threw: err instanceof Error ? err.message : String(err) }) + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

void main();

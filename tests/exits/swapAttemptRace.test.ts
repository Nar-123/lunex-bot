import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { buildSwapDeps, readExitSwapBuildContext } from '../../src/exits/swapTx';
import type { SwapVerifyData } from '../../src/exits/swapTx';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';

// Same-attempt swap race: two workers on the SAME swap attempt (same
// idempotencyKey -- e.g. worker A's claim lease expired and worker B
// resumed the position). Each fetched its own quote. These drive the REAL
// executeCriticalTransaction pipeline with the REAL buildSwapDeps
// (buildTransaction + verifyOnChain); only the chain/RPC steps are fakes.
// Coordination is by latches -- no sleeps.

const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const U = 10n ** 18n;
const KEY = 'exit:pos-1:close:swap:0';

/** Calldata that ENCODES the quote's minimum, so tests can prove calldata <-> stored minimum pairing. */
const calldataFor = (quote: SwapQuote): TxRequest => ({ to: '0x1111111111111111111111111111111111111111' as Address, data: `0x${quote.minOutputAmountRaw.toString(16)}` as `0x${string}`, value: 0n });
const minEncodedIn = (data: `0x${string}`): bigint => BigInt(data);

const QUOTE_A: SwapQuote = { amountInRaw: 10n * U, expectedAmountOutRaw: 950n * U, minOutputAmountRaw: 900n * U, priceImpactPct: 0.004, slippageBps: 100, providerQuote: { worker: 'A' } };
const QUOTE_B: SwapQuote = { amountInRaw: 10n * U, expectedAmountOutRaw: 840n * U, minOutputAmountRaw: 800n * U, priceImpactPct: 0.002, slippageBps: 100, providerQuote: { worker: 'B' } };
const RECEIPT_PAYS = 850n * U; // >= B's minimum (800), < A's minimum (900): a mixed pairing would mis-verify

function latch(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}

interface Park {
  at: 'buildSwapTx' | 'simulate' | 'checkGasAffordable';
  entered: () => void;
  gate: Promise<void>;
}

function worker(quote: SwapQuote, exitStates: InMemoryExitStateRepository, baseline: bigint, park?: Park) {
  const calls = { buildSwapTx: 0, simulate: 0, sign: 0, broadcast: 0 };
  const parkIf = async (step: Park['at']) => {
    if (park?.at === step) {
      park.entered();
      await park.gate;
    }
  };
  const executor: SwapExecutor = {
    getQuote: vi.fn(),
    checkApproval: vi.fn(),
    buildSwapTx: vi.fn(async () => {
      calls.buildSwapTx++;
      await parkIf('buildSwapTx'); // quote already obtained, BUILT not yet persisted
      return calldataFor(quote);
    }),
  };
  const real = buildSwapDeps('pos-1', TOKEN, quote, executor, exitStates, {
    swapAttemptCount: 0,
    readBalance: vi.fn(async () => baseline),
    readUsdgTransfersTo: vi.fn(async () => RECEIPT_PAYS),
    walletAddress: WALLET,
  });
  const deps: TxSafetyDeps<SwapVerifyData> = {
    ...real, // REAL buildTransaction + verifyOnChain
    simulate: vi.fn(async () => {
      calls.simulate++;
      await parkIf('simulate');
      return { ok: true } as const;
    }),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1n),
    checkGasAffordable: vi.fn(async () => {
      await parkIf('checkGasAffordable');
      return { ok: true } as const;
    }),
    getNonce: vi.fn(async () => 7),
    signTransaction: vi.fn(async () => {
      calls.sign++;
      return { raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` };
    }),
    broadcastRaw: vi.fn(async () => {
      calls.broadcast++;
    }),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
  };
  return { deps, calls };
}

async function setup() {
  const exitStates = new InMemoryExitStateRepository();
  const txAttempts = new InMemoryTransactionAttemptRepository();
  await exitStates.getOrCreate('pos-1');
  return { exitStates, txAttempts };
}

describe('Same-attempt swap race -- one attempt = one owner = one quote snapshot = one build/sign path', () => {
  it('(1-11, 14-18, 22) A obtains quote A and is paused before BUILT is persisted; B takes the same attempt, persists quote B and completes; A resumes -> A\'s write is rejected, A never simulates/signs/broadcasts, and B\'s snapshot (min/expected/impact/baseline) is intact and paired with B\'s calldata', async () => {
    const { exitStates, txAttempts } = await setup();
    const aEntered = latch();
    const aGate = latch();
    const A = worker(QUOTE_A, exitStates, 1000n * U, { at: 'buildSwapTx', entered: aEntered.release, gate: aGate.wait });
    const B = worker(QUOTE_B, exitStates, 1200n * U);

    const runA = executeCriticalTransaction(KEY, 'exit:swap', A.deps, txAttempts);
    await aEntered.wait; // A holds quote A, has not persisted anything for it

    const resultB = await executeCriticalTransaction(KEY, 'exit:swap', B.deps, txAttempts); // "claim expired": B owns the attempt now
    expect(resultB.ok).toBe(true);
    if (resultB.ok) expect(resultB.data.usdgProceedsRaw).toBe(RECEIPT_PAYS);

    aGate.release();
    const resultA = await runA;
    expect(resultA.ok).toBe(false);
    if (!resultA.ok) {
      expect(resultA.resumable).toBe(true); // ambiguous/PENDING -- never a definitive failure, nothing was sent
      expect(resultA.reason).toMatch(/not at expected version/);
    }
    expect(A.calls).toEqual({ buildSwapTx: 1, simulate: 0, sign: 0, broadcast: 0 });
    expect(B.calls.broadcast).toBe(1);

    const attempt = (await txAttempts.find(KEY))!;
    expect(attempt.status).toBe('VERIFIED');
    const ctx = readExitSwapBuildContext(attempt.txRequest?.buildContext)!;
    expect(ctx).toMatchObject({
      minOutputAmountRaw: QUOTE_B.minOutputAmountRaw,
      expectedAmountOutRaw: QUOTE_B.expectedAmountOutRaw,
      priceImpactPct: QUOTE_B.priceImpactPct,
      usdgBalanceBeforeRaw: 1200n * U,
    });
    expect(minEncodedIn(attempt.txRequest!.data)).toBe(ctx.minOutputAmountRaw); // calldata B <-> minimum B
    const shared = await exitStates.getOrCreate('pos-1');
    expect(shared.swapMinOutputAmountRaw).toBeNull(); // no shared minimum exists to be mixed
    expect(shared.swapUsdgBalanceBeforeRaw).toBeNull();
  });

  it('(12-13) single worker: quote A -> calldata A with minimum A; quote B -> calldata B with minimum B (each attempt its own)', async () => {
    for (const [quote, key] of [[QUOTE_A, 'exit:pos-1:c1:swap:0'], [QUOTE_B, 'exit:pos-1:c2:swap:0']] as const) {
      const { exitStates, txAttempts } = await setup();
      const W = worker(quote, exitStates, 1000n * U);
      await executeCriticalTransaction(key, 'exit:swap', W.deps, txAttempts);
      const attempt = (await txAttempts.find(key))!;
      const ctx = readExitSwapBuildContext(attempt.txRequest?.buildContext)!;
      expect(minEncodedIn(attempt.txRequest!.data)).toBe(quote.minOutputAmountRaw);
      expect(ctx.minOutputAmountRaw).toBe(quote.minOutputAmountRaw);
    }
  });

  it('(19) ownership already taken before A builds: A reads the attempt after B persisted BUILT -> A never calls buildSwapTx and never re-signs; it can only resume B\'s exact persisted calldata', async () => {
    const { exitStates, txAttempts } = await setup();
    const bEntered = latch();
    const bGate = latch();
    const B = worker(QUOTE_B, exitStates, 1200n * U, { at: 'simulate', entered: bEntered.release, gate: bGate.wait });
    const runB = executeCriticalTransaction(KEY, 'exit:swap', B.deps, txAttempts);
    await bEntered.wait; // B has persisted BUILT (calldata + snapshot) and is simulating

    const A = worker(QUOTE_A, exitStates, 1000n * U);
    const resultA = await executeCriticalTransaction(KEY, 'exit:swap', A.deps, txAttempts);
    expect(A.calls.buildSwapTx).toBe(0); // no second build of this attempt
    bGate.release();
    const resultB = await runB;

    expect([resultA.ok, resultB.ok]).toContain(true);
    expect(A.calls.broadcast + B.calls.broadcast).toBeGreaterThanOrEqual(1);
    const attempt = (await txAttempts.find(KEY))!;
    expect(minEncodedIn(attempt.txRequest!.data)).toBe(QUOTE_B.minOutputAmountRaw); // only ever B's calldata
    expect(readExitSwapBuildContext(attempt.txRequest?.buildContext)!.minOutputAmountRaw).toBe(QUOTE_B.minOutputAmountRaw);
  });

  it('(20-21) ownership changes AFTER A built but BEFORE A signs: A is parked at the gas check, B advances the attempt; A\'s next checkpoint write is rejected -> A never signs and never broadcasts', async () => {
    const { exitStates, txAttempts } = await setup();
    const aEntered = latch();
    const aGate = latch();
    const A = worker(QUOTE_A, exitStates, 1000n * U, { at: 'checkGasAffordable', entered: aEntered.release, gate: aGate.wait });
    const runA = executeCriticalTransaction(KEY, 'exit:swap', A.deps, txAttempts);
    await aEntered.wait; // A owns BUILT/SIMULATED (A's calldata + A's snapshot persisted together)

    const B = worker(QUOTE_B, exitStates, 1200n * U);
    const resultB = await executeCriticalTransaction(KEY, 'exit:swap', B.deps, txAttempts);
    expect(B.calls.buildSwapTx).toBe(0); // B resumes A's persisted calldata -- it does not rebuild
    expect(resultB.ok).toBe(false); // RECEIPT_PAYS (850) < A's own minimum (900): verified against A's OWN snapshot -> definitive
    if (!resultB.ok) expect(resultB.resumable).toBeFalsy();

    aGate.release();
    const resultA = await runA;
    expect(resultA.ok).toBe(false);
    expect(A.calls.sign).toBe(0);
    expect(A.calls.broadcast).toBe(0);
    const attempt = (await txAttempts.find(KEY))!;
    expect(minEncodedIn(attempt.txRequest!.data)).toBe(QUOTE_A.minOutputAmountRaw);
    expect(readExitSwapBuildContext(attempt.txRequest?.buildContext)!.minOutputAmountRaw).toBe(QUOTE_A.minOutputAmountRaw); // never B's minimum next to A's calldata
  });

  it('(30) restart: the snapshot survives the attempt row\'s JSON round-trip, and a fresh verifier (new process) checks against THAT attempt\'s own minimum -- not anything shared', async () => {
    const { exitStates, txAttempts } = await setup();
    const A = worker(QUOTE_A, exitStates, 1000n * U);
    const verifyOnChain = A.deps.verifyOnChain;
    // Stop right after confirmation (verification "incomplete"), as if the process died.
    await executeCriticalTransaction(KEY, 'exit:swap', { ...A.deps, verifyOnChain: vi.fn(async () => ({ ok: false as const, resumable: true, reason: 'process died' })) }, txAttempts);
    const persisted = (await txAttempts.find(KEY))!;
    expect(persisted.status).toBe('CONFIRMED');

    const roundTripped = JSON.parse(
      JSON.stringify(persisted.txRequest, (_k, v: unknown) => (typeof v === 'bigint' ? `bigint:${v.toString()}` : v)),
      (_k, v: unknown) => (typeof v === 'string' && v.startsWith('bigint:') ? BigInt(v.slice(7)) : v),
    );
    // Someone else later left a DIFFERENT (lower) minimum in the old shared columns -- it must be ignored.
    await exitStates.update('pos-1', { swapMinOutputAmountRaw: 1n });
    const result = await verifyOnChain(`0x${'ab'.repeat(32)}`, { id: persisted.id, txRequest: roundTripped });
    expect(result.ok).toBe(false); // 850 < A's own 900 -- the attempt's own snapshot governs
  });
});

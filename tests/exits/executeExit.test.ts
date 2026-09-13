import { describe, expect, it, vi } from 'vitest';
import { executeExit, exitSlippageBpsForAttempt } from '../../src/exits/executeExit';
import type { ExecuteExitDeps } from '../../src/exits/executeExit';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { makeCreateInput } from '../positions/fixtures';
import { PositionCapitalSnapshotProvider } from '../../src/positions/capitalSnapshotProvider';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';
import type { Address } from 'viem';

const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const SPENDER = '0x3333333333333333333333333333333333333333' as Address;
const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;

function fakeTxDeps<T>(data: T, overrides: Partial<TxSafetyDeps<T>> = {}): TxSafetyDeps<T> {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 7),
    signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 123n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data })),
    ...overrides,
  };
}

/** A remove-liquidity leg that always succeeds. */
function successfulRemoveDeps() {
  return vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: 0n }));
}

/** A remove-liquidity leg that fails DEFINITIVELY (e.g. SIMULATION_REJECTED) -- never reaches VERIFIED. */
function definitivelyFailingRemoveDeps(reason = 'would revert: STF') {
  return vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: 0n }, { simulate: vi.fn(async () => ({ ok: false, reason })) }));
}

/** A remove-liquidity leg whose broadcast is merely AMBIGUOUS (resumable) -- e.g. a network blip. */
function ambiguousRemoveDeps() {
  return vi.fn(() =>
    fakeTxDeps(
      { liquidityZero: true as const, usdgProceedsRaw: 0n },
      { broadcastRaw: vi.fn(async () => { throw new Error('ECONNRESET'); }) },
    ),
  );
}

function successfulSwapDeps() {
  return vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: USDG(100), usdgProceedsRaw: USDG(100) }));
}

function definitivelyFailingSwapDeps(reason = 'swap reverted: INSUFFICIENT_OUTPUT_AMOUNT') {
  return vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }, { simulate: vi.fn(async () => ({ ok: false, reason })) }));
}

function successfulApproveDeps() {
  return vi.fn(() => fakeTxDeps({ allowanceRaw: USDG(500) }));
}

function definitivelyFailingApproveDeps(reason = 'approve reverted') {
  return vi.fn(() => fakeTxDeps({ allowanceRaw: 0n }, { simulate: vi.fn(async () => ({ ok: false, reason })) }));
}

async function makeClosingPosition(positions: InMemoryPositionRepository, entryUsdgRaw = USDG(500)) {
  const created = await positions.create(makeCreateInput({ entryUsdgRaw, tokenAddress: TOKEN }));
  await positions.markActive(created.id, '1', new Date());
  await positions.markClosing(created.id, `exit:${created.id}:attempt-1`);
  const position = await positions.findById(created.id);
  if (!position) throw new Error('unreachable');
  return position;
}

function makeQuote(overrides: Partial<SwapQuote> = {}): SwapQuote {
  return { amountInRaw: USDG(500), expectedAmountOutRaw: USDG(490), minOutputAmountRaw: 0n, priceImpactPct: 0.001, slippageBps: 100, providerQuote: { fake: true }, ...overrides };
}

function makeSwapExecutor(quote: SwapQuote = makeQuote(), approvalCheck: { needsApproval: boolean; spender: Address | null } = { needsApproval: false, spender: null }): SwapExecutor {
  return { getQuote: vi.fn(async () => quote), checkApproval: vi.fn(async () => approvalCheck), buildSwapTx: vi.fn() };
}

/** Base deps shared by every test -- individual tests override the pieces they care about. `readTokenBalance`/`readAllowance` are stubbed (never hit a real RPC) since `executeExit` now always calls them once remove-liquidity succeeds. */
function baseDeps(overrides: Partial<ExecuteExitDeps> = {}): Omit<ExecuteExitDeps, 'positions' | 'exitStates' | 'txAttempts'> {
  return {
    livePositionState: { getLiveState: vi.fn() },
    poolPrice: { getPriceState: vi.fn() },
    swapExecutor: makeSwapExecutor(),
    readTokenBalance: vi.fn(async () => USDG(500)),
    readAllowance: vi.fn(async () => 0n),
    walletAddress: WALLET,
    ...overrides,
  };
}

describe('executeExit -- C3 regression: swap already VERIFIED must never re-derive the live TOKEN balance', () => {
  it('CRASH-RECOVERY: remove-liquidity VERIFIED, swap VERIFIED, process crashes before markClosed; resume reaches CLOSED with no second swap, no second remove-liquidity, no extra approval', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const position = await makeClosingPosition(positions, USDG(500));

    exitStates.seed({ positionId: position.id, pendingCloseReason: 'HARD_STOP_LOSS', swapAttemptCount: 0, trailingPeakPnlPct: null, drawdownConfirmStartedAt: null, oorStartedAt: null, safetyExitArmedAt: null, maxDrawdownPnlPct: null, metricsFailureSince: null, swapUsdgBalanceBeforeRaw: null, swapMinOutputAmountRaw: null });

    // "Process 1" (before the simulated crash): both legs already reached
    // VERIFIED and are persisted -- exactly the state a crash right before
    // markClosed would leave behind.
    const removeKey = `${position.closeIdempotencyKey}:removeLiquidity`;
    const removeAttempt = await txAttempts.create(removeKey, 'exit:removeLiquidity');
    await txAttempts.update(removeAttempt.id, { status: 'VERIFIED', verifyData: { liquidityZero: true } });
    const swapKey = `${position.closeIdempotencyKey}:swap:0`;
    const swapAttempt = await txAttempts.create(swapKey, 'exit:swap');
    await txAttempts.update(swapAttempt.id, { status: 'VERIFIED', verifyData: { usdgIncreaseRaw: USDG(490), usdgProceedsRaw: USDG(490) } });

    // "Process 2" (resume): if remove-liquidity or swap were re-executed
    // at all, these would throw. readTokenBalance would throw too --
    // proving the live balance is never even read on this path.
    const buildRemoveLiquidityDeps = vi.fn(() =>
      fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: 0n }, { buildTransaction: vi.fn(async () => { throw new Error('must never rebuild remove-liquidity for an already-VERIFIED attempt'); }) }),
    );
    const buildSwapDeps = vi.fn(() =>
      fakeTxDeps({ usdgIncreaseRaw: USDG(490), usdgProceedsRaw: USDG(490) }, { buildTransaction: vi.fn(async () => { throw new Error('must never rebuild swap for an already-VERIFIED attempt'); }) }),
    );
    const readTokenBalance = vi.fn(async () => { throw new Error('must never read live TOKEN balance when swap is already VERIFIED'); });

    const outcome = await executeExit(position, {
      positions,
      exitStates,
      txAttempts,
      ...baseDeps({ buildRemoveLiquidityDeps, buildSwapDeps, readTokenBalance }),
    });

    expect(outcome.outcome).toBe('CLOSED');
    const reloaded = await positions.findById(position.id);
    expect(reloaded?.status).toBe('CLOSED');
    expect(reloaded?.closedAt).not.toBeNull();
    expect(reloaded?.closeReason).toBe('HARD_STOP_LOSS');
    // VALIDATION PHASE: the seeded remove-liquidity verifyData is a LEGACY
    // shape (pre-dates the proceeds field), so the realized proceeds are
    // honestly NOT measured -- null, never a silently under-counted sum.
    // The close itself is not blocked by the unmeasurable accounting read.
    expect(reloaded?.realizedUsdgRaw).toBeNull();
    expect(readTokenBalance).not.toHaveBeenCalled();
  });

  it('VALIDATION PHASE full pipeline: both legs measured -> markClosed persists proceeds = remove + swap, exactly', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const position = await makeClosingPosition(positions, USDG(500));

    exitStates.seed({ positionId: position.id, pendingCloseReason: 'HARD_STOP_LOSS', swapAttemptCount: 0, trailingPeakPnlPct: null, drawdownConfirmStartedAt: null, oorStartedAt: null, safetyExitArmedAt: null, maxDrawdownPnlPct: null, metricsFailureSince: null, swapUsdgBalanceBeforeRaw: null, swapMinOutputAmountRaw: null });

    // Remove-liquidity paid out 480 USDG (principal+fees side in USDG),
    // the swap paid out 490 USDG -> 970 total measured proceeds.
    const buildRemoveLiquidityDeps = vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: USDG(480) }));
    const buildSwapDeps = vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: USDG(490), usdgProceedsRaw: USDG(490) }));

    const outcome = await executeExit(position, {
      positions,
      exitStates,
      txAttempts,
      ...baseDeps({ buildRemoveLiquidityDeps, buildSwapDeps }),
    });

    expect(outcome.outcome).toBe('CLOSED');
    const reloaded = await positions.findById(position.id);
    expect(reloaded?.status).toBe('CLOSED');
    expect(reloaded?.realizedUsdgRaw).toBe(USDG(970)); // persisted atomically with the CLOSED transition
  });

  it('swap VERIFIED with TOKEN balance genuinely reading zero: reaches CLOSED, never throws the invariant violation', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const position = await makeClosingPosition(positions, USDG(500));

    exitStates.seed({ positionId: position.id, pendingCloseReason: 'TRAILING_TP', swapAttemptCount: 0, trailingPeakPnlPct: null, drawdownConfirmStartedAt: null, oorStartedAt: null, safetyExitArmedAt: null, maxDrawdownPnlPct: null, metricsFailureSince: null, swapUsdgBalanceBeforeRaw: null, swapMinOutputAmountRaw: null });

    const removeKey = `${position.closeIdempotencyKey}:removeLiquidity`;
    const removeAttempt = await txAttempts.create(removeKey, 'exit:removeLiquidity');
    await txAttempts.update(removeAttempt.id, { status: 'VERIFIED', verifyData: { liquidityZero: true } });
    const swapKey = `${position.closeIdempotencyKey}:swap:0`;
    const swapAttempt = await txAttempts.create(swapKey, 'exit:swap');
    await txAttempts.update(swapAttempt.id, { status: 'VERIFIED', verifyData: { usdgIncreaseRaw: USDG(490), usdgProceedsRaw: USDG(490) } });

    const outcome = await executeExit(position, {
      positions,
      exitStates,
      txAttempts,
      ...baseDeps({ readTokenBalance: vi.fn(async () => 0n) }), // the historical trigger for the invariant throw
    });

    expect(outcome.outcome).toBe('CLOSED');
  });
});

describe('executeExit -- the failed-exit state machine (point 3)', () => {
  describe('branch A: remove-liquidity fails DEFINITIVELY, before ever reaching VERIFIED', () => {
    it('numeric proof: reverts CLOSING -> ACTIVE, clears closeIdempotencyKey, and capital accounting stays correct (still deployed, still occupies a slot)', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));

      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({
          buildRemoveLiquidityDeps: definitivelyFailingRemoveDeps(),
          buildSwapDeps: successfulSwapDeps(), // must never be reached
        }),
      });

      expect(outcome.outcome).toBe('REVERTED_TO_ACTIVE');

      const reloaded = await positions.findById(position.id);
      expect(reloaded?.status).toBe('ACTIVE');
      expect(reloaded?.closeIdempotencyKey).toBeNull();

      // Capital accounting: TRUE state is "this position never left ACTIVE"
      // -- entryUsdgRaw (500) must still be fully counted as deployed and
      // still occupy an activePositionsCount slot, exactly as it did before
      // the failed exit attempt. No capitalSnapshotProvider change was
      // needed for this (Revision 5/6/7's NON_CLOSED_STATUSES already
      // includes ACTIVE) -- proven here, not assumed.
      const snapshotProvider = new PositionCapitalSnapshotProvider(positions, WALLET, async () => USDG(1000));
      const snapshot = await snapshotProvider.getSnapshot();
      expect(snapshot.totalDeployedUsdg).toBe(USDG(500));
      expect(snapshot.activePositionsCount).toBe(1);
    });

    it('the NEXT exit attempt (fresh trigger evaluation) gets a brand-new closeIdempotencyKey, never the dead one', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      const originalKey = position.closeIdempotencyKey;

      await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: definitivelyFailingRemoveDeps(), buildSwapDeps: successfulSwapDeps() }),
      });

      // Simulate the NEXT tick: trigger re-fires (e.g. still HARD_STOP_LOSS), markClosing called again.
      const newKey = `exit:${position.id}:attempt-2`;
      await positions.markClosing(position.id, newKey);
      const secondAttemptPosition = await positions.findById(position.id);

      expect(secondAttemptPosition?.closeIdempotencyKey).toBe(newKey);
      expect(secondAttemptPosition?.closeIdempotencyKey).not.toBe(originalKey);
    });

    it('COUNTER-PROOF: what "stuck forever" would look like -- reusing the SAME dead key returns the cached FAILED result forever, the build is never retried', async () => {
      const positions = new InMemoryPositionRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      const removeKey = `${position.closeIdempotencyKey}:removeLiquidity`;

      const buildRemoveDeps = definitivelyFailingRemoveDeps('would revert: STF');
      const deps = buildRemoveDeps();
      const first = await executeCriticalTransaction(removeKey, 'exit:removeLiquidity', deps, txAttempts);
      expect(first.ok).toBe(false);
      if (first.ok) throw new Error('unreachable');
      expect(first.resumable).toBe(false);
      expect(deps.buildTransaction).toHaveBeenCalledTimes(1);

      // Calling it again with the EXACT SAME key -- this is what would
      // happen if markExitFailed did NOT clear closeIdempotencyKey and a
      // "retry" naively reused it.
      const deps2 = buildRemoveDeps(); // a fresh TxSafetyDeps object, to prove buildTransaction is never even INVOKED the second time
      const second = await executeCriticalTransaction(removeKey, 'exit:removeLiquidity', deps2, txAttempts);
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error('unreachable');
      expect(second.resumable).toBe(false);
      expect(second.reason).toBe(first.reason); // same cached failure, forever
      expect(deps2.buildTransaction).not.toHaveBeenCalled(); // proves it short-circuited on the cached FAILED attempt rather than retrying

      // This is exactly why markExitFailed clearing closeIdempotencyKey (proven in the previous two tests) is REQUIRED, not optional.
    });

    it('an AMBIGUOUS (resumable) remove-liquidity failure does NOT revert to ACTIVE -- stays CLOSING, retried with the SAME key next tick', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));

      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: ambiguousRemoveDeps(), buildSwapDeps: successfulSwapDeps() }),
      });

      expect(outcome.outcome).toBe('PENDING');
      const reloaded = await positions.findById(position.id);
      expect(reloaded?.status).toBe('CLOSING'); // untouched -- markExitFailed must NEVER be called for an ambiguous failure
      expect(reloaded?.closeIdempotencyKey).toBe(position.closeIdempotencyKey);
    });
  });

  describe('branch B: swap fails DEFINITIVELY, AFTER remove-liquidity already reached VERIFIED -- the sub-case the naive fix misses', () => {
    it('numeric proof: position STAYS CLOSING (does NOT revert to ACTIVE), swapAttemptCount increments, and capital is still correctly counted as deployed', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));

      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps: definitivelyFailingSwapDeps() }),
      });

      expect(outcome.outcome).toBe('SWAP_FAILED_RETRY_PENDING');

      const reloaded = await positions.findById(position.id);
      // The critical assertion: NOT reverted to ACTIVE. The LP is genuinely
      // gone (remove-liquidity was verified) -- reverting would misrepresent
      // reality (no LP left to compute PNL against).
      expect(reloaded?.status).toBe('CLOSING');
      expect(reloaded?.closeIdempotencyKey).toBe(position.closeIdempotencyKey); // unchanged -- remove-liquidity's key must stay stable

      const exitState = await exitStates.getOrCreate(position.id);
      expect(exitState.swapAttemptCount).toBe(1);

      // Capital accounting: this position is CLOSING, which
      // findDeployedPositions()/totalDeployedUsdg already includes
      // unconditionally (Revision 5) -- regardless of WHICH sub-phase of
      // CLOSING it's in. Proven here for the LP-already-removed,
      // swap-pending sub-phase specifically, not just assumed to inherit
      // Revision 5's proof.
      const snapshotProvider = new PositionCapitalSnapshotProvider(positions, WALLET, async () => USDG(1000));
      const snapshot = await snapshotProvider.getSnapshot();
      expect(snapshot.totalDeployedUsdg).toBe(USDG(500));
      expect(snapshot.activePositionsCount).toBe(1);
    });

    it('the retry uses a FRESH swap key derived from the bumped counter, while remove-liquidity SHORT-CIRCUITS as already-VERIFIED (never rebuilt, re-signed, or re-broadcast)', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      await exitStates.update(position.id, { pendingCloseReason: 'OOR_TIMEOUT' });

      const removeDepsFactory = successfulRemoveDeps();
      await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: removeDepsFactory, buildSwapDeps: definitivelyFailingSwapDeps() }),
      });
      expect(removeDepsFactory).toHaveBeenCalledTimes(1);
      const firstRemoveTxDeps = removeDepsFactory.mock.results[0]?.value as TxSafetyDeps<unknown>;
      expect(firstRemoveTxDeps.buildTransaction).toHaveBeenCalledTimes(1);

      // Resume: executeExit called again on the (still CLOSING) position.
      const reloaded = await positions.findById(position.id);
      if (!reloaded) throw new Error('unreachable');

      const swapDepsFactory = successfulSwapDeps();
      const outcome = await executeExit(reloaded, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({
          buildRemoveLiquidityDeps: removeDepsFactory, // SAME factory instance -- if called again AND its buildTransaction runs again, that's Tx A being duplicated, which must never happen
          buildSwapDeps: swapDepsFactory,
        }),
      });

      expect(outcome.outcome).toBe('CLOSED');

      // Tx A's deps ARE constructed again (buildRemoveLiquidityDeps(position, ...) is called fresh each executeExit invocation, cheap/pure),
      // but its buildTransaction must NEVER be invoked again -- proving executeCriticalTransaction short-circuited on the cached VERIFIED attempt.
      const secondRemoveTxDeps = removeDepsFactory.mock.results[1]?.value as TxSafetyDeps<unknown>;
      expect(secondRemoveTxDeps.buildTransaction).not.toHaveBeenCalled();

      // The swap leg's key must have used the bumped counter (1, from the first failed attempt).
      const swapAttemptAfterFirstFailure = 1;
      const expectedSecondSwapKey = `${position.closeIdempotencyKey}:swap:${swapAttemptAfterFirstFailure}`;
      const secondSwapAttempt = await txAttempts.find(expectedSecondSwapKey);
      expect(secondSwapAttempt?.status).toBe('VERIFIED');

      // And the FIRST (failed) swap key is untouched/still FAILED -- a genuinely different row, not resumed.
      const firstSwapAttempt = await txAttempts.find(`${position.closeIdempotencyKey}:swap:0`);
      expect(firstSwapAttempt?.status).toBe('FAILED');
    });

    it('an AMBIGUOUS (resumable) swap failure does NOT bump swapAttemptCount and does NOT revert to ACTIVE -- retried with the SAME swap key next tick', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));

      const ambiguousSwap = vi.fn(() =>
        fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }, { broadcastRaw: vi.fn(async () => { throw new Error('RPC dropped'); }) }),
      );

      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps: ambiguousSwap }),
      });

      expect(outcome.outcome).toBe('PENDING');
      const reloaded = await positions.findById(position.id);
      expect(reloaded?.status).toBe('CLOSING');
      const exitState = await exitStates.getOrCreate(position.id);
      expect(exitState.swapAttemptCount).toBe(0); // NOT incremented -- only a definitive failure bumps this
    });
  });

  describe('the approve leg (Permit2 opt-out) -- only runs when checkApproval names a spender and current allowance is insufficient', () => {
    it('is skipped entirely when checkApproval reports no approval needed for this route', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      await exitStates.update(position.id, { pendingCloseReason: 'HARD_STOP_LOSS' });
      const buildApproveDeps = successfulApproveDeps();

      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({
          buildRemoveLiquidityDeps: successfulRemoveDeps(),
          buildSwapDeps: successfulSwapDeps(),
          buildApproveDeps,
          swapExecutor: makeSwapExecutor(makeQuote(), { needsApproval: false, spender: null }),
        }),
      });

      expect(outcome).toEqual({ outcome: 'CLOSED' });
      expect(buildApproveDeps).not.toHaveBeenCalled();
    });

    it('is skipped when checkApproval names a spender but current on-chain allowance is already sufficient', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      await exitStates.update(position.id, { pendingCloseReason: 'HARD_STOP_LOSS' });
      const buildApproveDeps = successfulApproveDeps();

      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({
          buildRemoveLiquidityDeps: successfulRemoveDeps(),
          buildSwapDeps: successfulSwapDeps(),
          buildApproveDeps,
          swapExecutor: makeSwapExecutor(makeQuote({ amountInRaw: USDG(500) }), { needsApproval: true, spender: SPENDER }),
          readAllowance: vi.fn(async () => USDG(1000)), // already plenty
          readTokenBalance: vi.fn(async () => USDG(500)),
        }),
      });

      expect(outcome).toEqual({ outcome: 'CLOSED' });
      expect(buildApproveDeps).not.toHaveBeenCalled();
    });

    it('runs when allowance is insufficient, and succeeds through to the swap', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      await exitStates.update(position.id, { pendingCloseReason: 'HARD_STOP_LOSS' });
      const buildApproveDeps = successfulApproveDeps();

      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({
          buildRemoveLiquidityDeps: successfulRemoveDeps(),
          buildSwapDeps: successfulSwapDeps(),
          buildApproveDeps,
          swapExecutor: makeSwapExecutor(makeQuote({ amountInRaw: USDG(500) }), { needsApproval: true, spender: SPENDER }),
          readAllowance: vi.fn(async () => 0n),
          readTokenBalance: vi.fn(async () => USDG(500)),
        }),
      });

      expect(outcome).toEqual({ outcome: 'CLOSED' });
      expect(buildApproveDeps).toHaveBeenCalledWith(TOKEN, SPENDER, USDG(500));
      const approveAttempt = await txAttempts.find(`${position.closeIdempotencyKey}:approve:0`);
      expect(approveAttempt?.status).toBe('VERIFIED');
    });

    it('numeric proof: a DEFINITIVE approve failure (LP already gone) stays CLOSING and bumps swapAttemptCount, same as a swap failure', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      const buildApproveDeps = definitivelyFailingApproveDeps();
      const buildSwapDeps = successfulSwapDeps();

      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({
          buildRemoveLiquidityDeps: successfulRemoveDeps(),
          buildSwapDeps,
          buildApproveDeps,
          swapExecutor: makeSwapExecutor(makeQuote({ amountInRaw: USDG(500) }), { needsApproval: true, spender: SPENDER }),
          readAllowance: vi.fn(async () => 0n),
          readTokenBalance: vi.fn(async () => USDG(500)),
        }),
      });

      expect(outcome.outcome).toBe('SWAP_FAILED_RETRY_PENDING');
      const reloaded = await positions.findById(position.id);
      expect(reloaded?.status).toBe('CLOSING'); // NOT reverted -- LP already gone, same reasoning as a swap failure
      const exitState = await exitStates.getOrCreate(position.id);
      expect(exitState.swapAttemptCount).toBe(1);
      expect(buildSwapDeps).not.toHaveBeenCalled(); // never reached the swap leg this attempt
    });

    it('an AMBIGUOUS approve failure stays CLOSING without bumping swapAttemptCount, retried with the SAME approve key next tick', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      const ambiguousApprove = vi.fn(() =>
        fakeTxDeps({ allowanceRaw: 0n }, { broadcastRaw: vi.fn(async () => { throw new Error('RPC dropped'); }) }),
      );

      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({
          buildRemoveLiquidityDeps: successfulRemoveDeps(),
          buildSwapDeps: successfulSwapDeps(),
          buildApproveDeps: ambiguousApprove,
          swapExecutor: makeSwapExecutor(makeQuote({ amountInRaw: USDG(500) }), { needsApproval: true, spender: SPENDER }),
          readAllowance: vi.fn(async () => 0n),
          readTokenBalance: vi.fn(async () => USDG(500)),
        }),
      });

      expect(outcome.outcome).toBe('PENDING');
      const reloaded = await positions.findById(position.id);
      expect(reloaded?.status).toBe('CLOSING');
      const exitState = await exitStates.getOrCreate(position.id);
      expect(exitState.swapAttemptCount).toBe(0);
    });
  });

  describe('price impact gate (executeExit owns this decision, before any swap TransactionAttempt is even created)', () => {
    /**
     * TIER 3 -- EXIT PRICE IMPACT. `EXIT_IMPACT_CHECK_ENABLED` now defaults
     * to TRUE and `MAX_EXIT_IMPACT` is 0.5% (Meridian `maxExitPriceImpactPct`).
     * The quote is taken at EXIT time (fresh, per tick), and a blocked exit
     * is PENDING -- deliberately NOT definitive: conditions right now are
     * bad, not permanently invalid, so the TOKEN balance is never abandoned
     * and the position stays CLOSING and resumable. Boundaries below are
     * inclusive-at-the-max, matching `shouldBlockForPriceImpact`'s `>`.
     */
    it('0.49% impact -- just inside the 0.5% cap -- passes, and the swap proceeds to CLOSED', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      await exitStates.update(position.id, { pendingCloseReason: 'HARD_STOP_LOSS' });
      const buildSwapDeps = successfulSwapDeps();

      const outcome = await executeExit(position, {
        positions, exitStates, txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps, swapExecutor: makeSwapExecutor(makeQuote({ priceImpactPct: 0.0049 })) }),
      });

      expect(outcome).toEqual({ outcome: 'CLOSED' });
      expect(buildSwapDeps).toHaveBeenCalled();
    });

    it('0.50% impact -- exactly AT the cap -- passes (it is a maximum, an inclusive bound, not an exclusive one)', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      await exitStates.update(position.id, { pendingCloseReason: 'HARD_STOP_LOSS' });
      const buildSwapDeps = successfulSwapDeps();

      const outcome = await executeExit(position, {
        positions, exitStates, txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps, swapExecutor: makeSwapExecutor(makeQuote({ priceImpactPct: 0.005 })) }),
      });

      expect(outcome).toEqual({ outcome: 'CLOSED' });
      expect(buildSwapDeps).toHaveBeenCalled();
    });

    it('0.51% impact -- one basis point past the cap -- is REJECTED as PENDING, with no swap attempt row created and the slippage tier NOT advanced', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      await exitStates.update(position.id, { pendingCloseReason: 'HARD_STOP_LOSS' });
      const buildSwapDeps = successfulSwapDeps();

      const outcome = await executeExit(position, {
        positions, exitStates, txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps, swapExecutor: makeSwapExecutor(makeQuote({ priceImpactPct: 0.0051 })) }),
      });

      expect(outcome.outcome).toBe('PENDING');
      expect(buildSwapDeps).not.toHaveBeenCalled(); // never even built
      expect(await txAttempts.find(`${position.closeIdempotencyKey}:swap:0`)).toBeNull(); // no attempt row at all

      // Price impact and slippage are SEPARATE protections: a quote with
      // unacceptable impact must NOT be rescued by widening the fill.
      const state = await exitStates.getOrCreate(position.id);
      expect(state.swapAttemptCount).toBe(0);

      // Resumable, not abandoned -- still CLOSING, TOKEN balance still ours.
      expect((await positions.findById(position.id))?.status).toBe('CLOSING');
    });

    it('UNVERIFIABLE impact (provider omitted priceImpact -> null) blocks too, and stays resumable -- an unmeasured impact is never treated as a zero impact', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      await exitStates.update(position.id, { pendingCloseReason: 'HARD_STOP_LOSS' });
      const buildSwapDeps = successfulSwapDeps();

      const outcome = await executeExit(position, {
        positions, exitStates, txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps, swapExecutor: makeSwapExecutor(makeQuote({ priceImpactPct: null })) }),
      });

      expect(outcome.outcome).toBe('PENDING');
      if (outcome.outcome === 'PENDING') expect(outcome.reason).toMatch(/could not be verified/);
      expect(buildSwapDeps).not.toHaveBeenCalled();
      expect((await positions.findById(position.id))?.status).toBe('CLOSING'); // recoverable, never a definitive FAILED
    });

    it('the impact quote is re-taken FRESH on every attempt -- a later tick whose impact has recovered proceeds, no stale quote is reused', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      await exitStates.update(position.id, { pendingCloseReason: 'HARD_STOP_LOSS' });

      // First tick: impact is bad. Second tick: it has recovered.
      let call = 0;
      const swapExecutor: SwapExecutor = {
        getQuote: vi.fn(async () => { call += 1; return makeQuote({ priceImpactPct: call === 1 ? 0.02 : 0.001 }); }),
        checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })),
        buildSwapTx: vi.fn(),
      };
      const buildSwapDeps = successfulSwapDeps();
      const deps = { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps, swapExecutor }) };

      expect((await executeExit(position, deps)).outcome).toBe('PENDING');
      expect(await executeExit(position, deps)).toEqual({ outcome: 'CLOSED' });
      expect(swapExecutor.getQuote).toHaveBeenCalledTimes(2); // re-quoted, not cached
    });

    describe('TIER 3 -- slippage escalation ladder (100 -> 200 -> 300 bps)', () => {
      /** Records the slippage each `getQuote` call was actually made with. */
      function recordingSwapExecutor(quote: SwapQuote = makeQuote()): { executor: SwapExecutor; bps: number[] } {
        const bps: number[] = [];
        const executor: SwapExecutor = {
          getQuote: vi.fn(async (_t: Address, _a: bigint, slippageBps: number) => { bps.push(slippageBps); return quote; }),
          checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })),
          buildSwapTx: vi.fn(),
        };
        return { executor, bps };
      }

      it('the FIRST attempt asks for 100 bps -- never jumps straight to the widest tier', async () => {
        const positions = new InMemoryPositionRepository();
        const exitStates = new InMemoryExitStateRepository();
        const txAttempts = new InMemoryTransactionAttemptRepository();
        const position = await makeClosingPosition(positions, USDG(500));
        const { executor, bps } = recordingSwapExecutor();

        await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps: successfulSwapDeps(), swapExecutor: executor }) });

        expect(bps).toEqual([100]);
      });

      it('a DEFINITIVE swap failure advances the tier: 1st=100, 2nd=200, 3rd=300 bps, in that order, never skipping 200', async () => {
        const positions = new InMemoryPositionRepository();
        const exitStates = new InMemoryExitStateRepository();
        const txAttempts = new InMemoryTransactionAttemptRepository();
        const position = await makeClosingPosition(positions, USDG(500));
        const { executor, bps } = recordingSwapExecutor();
        const deps = { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps: definitivelyFailingSwapDeps(), swapExecutor: executor }) };

        await executeExit(position, deps);
        await executeExit(position, deps);
        await executeExit(position, deps);

        expect(bps).toEqual([100, 200, 300]);
        expect((await exitStates.getOrCreate(position.id)).swapAttemptCount).toBe(3);
      });

      it('an AMBIGUOUS swap failure does NOT advance the tier -- the resumed attempt re-quotes at the SAME width, under the SAME idempotency key', async () => {
        const positions = new InMemoryPositionRepository();
        const exitStates = new InMemoryExitStateRepository();
        const txAttempts = new InMemoryTransactionAttemptRepository();
        const position = await makeClosingPosition(positions, USDG(500));
        const { executor, bps } = recordingSwapExecutor();
        const ambiguousSwapDeps = vi.fn(() =>
          fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }, { broadcastRaw: vi.fn(async () => { throw new Error('ECONNRESET'); }) }),
        );
        const deps = { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps: ambiguousSwapDeps, swapExecutor: executor }) };

        const first = await executeExit(position, deps);
        expect(first.outcome).toBe('PENDING'); // resumable, not definitive
        await executeExit(position, deps);

        // Widening the fill on the strength of a failure nobody has actually
        // established would be guessing, not escalating.
        expect(bps).toEqual([100, 100]);
        expect((await exitStates.getOrCreate(position.id)).swapAttemptCount).toBe(0);
      });

      it('a restart mid-flight does not duplicate an already-sent attempt: the prior VERIFIED swap short-circuits and nothing is re-quoted or re-sent at any tier', async () => {
        const positions = new InMemoryPositionRepository();
        const exitStates = new InMemoryExitStateRepository();
        const txAttempts = new InMemoryTransactionAttemptRepository();
        const position = await makeClosingPosition(positions, USDG(500));

        // "Before the crash": remove-liquidity and the tier-0 swap both reached VERIFIED.
        const removeAttempt = await txAttempts.create(`${position.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
        await txAttempts.update(removeAttempt.id, { status: 'VERIFIED', verifyData: { liquidityZero: true } });
        const swapAttempt = await txAttempts.create(`${position.closeIdempotencyKey}:swap:0`, 'exit:swap');
        await txAttempts.update(swapAttempt.id, { status: 'VERIFIED', verifyData: { usdgIncreaseRaw: USDG(490), usdgProceedsRaw: USDG(490) } });

        const { executor, bps } = recordingSwapExecutor();
        const buildSwapDeps = vi.fn(() => { throw new Error('must never re-send an already-VERIFIED swap'); });

        const outcome = await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps, swapExecutor: executor }) });

        expect(outcome).toEqual({ outcome: 'CLOSED' });
        expect(bps).toEqual([]); // never even re-quoted -- no second send at any tier
        expect(buildSwapDeps).not.toHaveBeenCalled();
      });

      it('past the last tier the width CLAMPS at 300 bps and the position stays recoverable and operator-visible -- the TOKEN balance is never silently abandoned', async () => {
        const positions = new InMemoryPositionRepository();
        const exitStates = new InMemoryExitStateRepository();
        const txAttempts = new InMemoryTransactionAttemptRepository();
        const position = await makeClosingPosition(positions, USDG(500));
        const { executor, bps } = recordingSwapExecutor();
        const deps = { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps: definitivelyFailingSwapDeps(), swapExecutor: executor }) };

        for (let i = 0; i < 5; i += 1) await executeExit(position, deps);

        expect(bps).toEqual([100, 200, 300, 300, 300]); // clamped, never runs off the end
        expect((await exitStates.getOrCreate(position.id)).swapAttemptCount).toBe(5);

        // Operator-visible: at/above STUCK_THRESHOLD (3 = the number of
        // tiers) this position is surfaced by the stuck-retry query rather
        // than quietly disappearing.
        expect(await exitStates.findStuckSwapRetries(3)).toContain(position.id);

        // Still CLOSING (recoverable), never FAILED-and-forgotten.
        expect((await positions.findById(position.id))?.status).toBe('CLOSING');
      });

      it('exitSlippageBpsForAttempt maps every tier index explicitly, including the clamp at both ends', () => {
        expect(exitSlippageBpsForAttempt(0)).toBe(100);
        expect(exitSlippageBpsForAttempt(1)).toBe(200);
        expect(exitSlippageBpsForAttempt(2)).toBe(300);
        expect(exitSlippageBpsForAttempt(3)).toBe(300);
        expect(exitSlippageBpsForAttempt(99)).toBe(300);
        expect(exitSlippageBpsForAttempt(-1)).toBe(100); // defensive: never below the tightest tier
      });
    });
  });

  describe('full happy path', () => {
    it('both legs succeed -> markClosed is called with the trigger reason recorded at markClosing time', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      await exitStates.update(position.id, { pendingCloseReason: 'HARD_STOP_LOSS' });

      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps: successfulSwapDeps() }),
      });

      expect(outcome).toEqual({ outcome: 'CLOSED' });
      const reloaded = await positions.findById(position.id);
      expect(reloaded?.status).toBe('CLOSED');
      expect(reloaded?.closeReason).toBe('HARD_STOP_LOSS');
    });

    it('C4 defense-in-depth: a missing pendingCloseReason (legacy/orphaned row) NEVER throws or strands the position -- falls back to UNKNOWN with a loud warning, still reaches CLOSED', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));
      // pendingCloseReason deliberately left null -- simulates a legacy
      // row from before the C4 write-order fix, or any other gap.

      const warnLog = vi.fn();
      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps: successfulSwapDeps(), warnLog }),
      });

      // The on-chain exit already fully succeeded -- this must NEVER throw
      // and strand the position at CLOSING forever over a metadata gap.
      expect(outcome).toEqual({ outcome: 'CLOSED' });
      const reloaded = await positions.findById(position.id);
      expect(reloaded?.status).toBe('CLOSED');
      expect(reloaded?.closeReason).toBe('UNKNOWN');
      expect(warnLog).toHaveBeenCalledWith('exit_missing_pending_close_reason', expect.objectContaining({ positionId: position.id }));
    });

    it('throws (invariant violation) if remove-liquidity is VERIFIED but TOKEN balance reads 0', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));

      await expect(
        executeExit(position, {
          positions,
          exitStates,
          txAttempts,
          ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), readTokenBalance: vi.fn(async () => 0n) }),
        }),
      ).rejects.toThrow(/TOKEN balance reads 0/);
    });
  });

  it('throws if called on a position with no closeIdempotencyKey (not actually CLOSING)', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput());
    await positions.markActive(created.id, '1', new Date());
    const active = await positions.findById(created.id);
    if (!active) throw new Error('unreachable');

    await expect(
      executeExit(active, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps: successfulSwapDeps() }),
      }),
    ).rejects.toThrow(/closeIdempotencyKey/);
  });
});

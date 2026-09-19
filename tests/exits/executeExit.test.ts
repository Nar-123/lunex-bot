import { describe, expect, it, vi } from 'vitest';
import { classifyUsdgOnlyRemoval, computeRealizedProceeds, executeExit, exitSlippageBpsForAttempt } from '../../src/exits/executeExit';
import type { ExecuteExitDeps } from '../../src/exits/executeExit';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { makeCreateInput } from '../positions/fixtures';
import { PositionCapitalSnapshotProvider } from '../../src/positions/capitalSnapshotProvider';
import { decideCapitalAllocation } from '../../src/capital/decideCapitalAllocation';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';
import type { Address } from 'viem';
import { config } from '../../src/config';

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

    exitStates.seed({ positionId: position.id, pendingCloseReason: 'HARD_STOP_LOSS', swapAttemptCount: 0, trailingPeakPnlPct: null, drawdownConfirmStartedAt: null, oorStartedAt: null, safetyExitArmedAt: null, maxDrawdownPnlPct: null, metricsFailureSince: null, swapUsdgBalanceBeforeRaw: null, swapMinOutputAmountRaw: null, swapVerifiedUsdgIncreaseRaw: null });

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

    exitStates.seed({ positionId: position.id, pendingCloseReason: 'HARD_STOP_LOSS', swapAttemptCount: 0, trailingPeakPnlPct: null, drawdownConfirmStartedAt: null, oorStartedAt: null, safetyExitArmedAt: null, maxDrawdownPnlPct: null, metricsFailureSince: null, swapUsdgBalanceBeforeRaw: null, swapMinOutputAmountRaw: null, swapVerifiedUsdgIncreaseRaw: null });

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

  it('P1-14: a HARD_STOP_LOSS close (a principal-only -6% trigger) can legitimately persist a realizedUsdgRaw showing a SMALLER loss than -6% once collected fees are folded in -- this is the intentional, operator-confirmed divergence documented in resolveExitDecision.ts, not a bug', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    // Entered at 500 USDG. The live pnlPct trigger that decided to close
    // this position (computed upstream by resolveExitDecision.ts, not by
    // executeExit.ts) was principal-only and crossed exactly -6% --
    // principal-only value at that moment would have been ~470. This test
    // starts from that already-CLOSING position (the trigger decision
    // itself is resolveExitDecision.test.ts's concern) and shows what
    // computeRealizedProceeds does next: it does NOT know or care what
    // triggered the close, it only sums actual USDG received.
    const position = await makeClosingPosition(positions, USDG(500));
    exitStates.seed({ positionId: position.id, pendingCloseReason: 'HARD_STOP_LOSS', swapAttemptCount: 0, trailingPeakPnlPct: null, drawdownConfirmStartedAt: null, oorStartedAt: null, safetyExitArmedAt: null, maxDrawdownPnlPct: null, metricsFailureSince: null, swapUsdgBalanceBeforeRaw: null, swapMinOutputAmountRaw: null, swapVerifiedUsdgIncreaseRaw: null });

    // Principal-only value at the -6% trigger would have been ~470, but the
    // SAME remove-liquidity settlement also paid out accrued fees the live
    // pnlPct never counted -- so the two legs together return 495, not 470.
    const buildRemoveLiquidityDeps = vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: USDG(495) }));
    const buildSwapDeps = vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: USDG(0), usdgProceedsRaw: USDG(0) }));

    const outcome = await executeExit(position, {
      positions,
      exitStates,
      txAttempts,
      ...baseDeps({ buildRemoveLiquidityDeps, buildSwapDeps }),
    });

    expect(outcome.outcome).toBe('CLOSED');
    const reloaded = await positions.findById(position.id);
    expect(reloaded?.closeReason).toBe('HARD_STOP_LOSS');
    // realizedUsdgRaw (495) - entryUsdgRaw (500) = -5 USDG = -1% realized,
    // even though the trigger that closed this position fired at -6%
    // principal-only. Neither number is wrong; they measure different
    // things. See resolveExitDecision.ts's "P1-14" doc comment.
    expect(reloaded?.realizedUsdgRaw).toBe(USDG(495));
    const realizedPnlRaw = (reloaded?.realizedUsdgRaw ?? 0n) - position.entryUsdgRaw;
    expect(realizedPnlRaw).toBe(-USDG(5));
    expect(realizedPnlRaw).toBeGreaterThan((position.entryUsdgRaw * -6n) / 100n); // realized loss is SMALLER in magnitude than the -6% trigger that fired
  });

  it('swap VERIFIED with TOKEN balance genuinely reading zero: reaches CLOSED, never throws the invariant violation', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const position = await makeClosingPosition(positions, USDG(500));

    exitStates.seed({ positionId: position.id, pendingCloseReason: 'TRAILING_TP', swapAttemptCount: 0, trailingPeakPnlPct: null, drawdownConfirmStartedAt: null, oorStartedAt: null, safetyExitArmedAt: null, maxDrawdownPnlPct: null, metricsFailureSince: null, swapUsdgBalanceBeforeRaw: null, swapMinOutputAmountRaw: null, swapVerifiedUsdgIncreaseRaw: null });

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

describe('executeExit -- P1: a proceeds-read failure after a confirmed on-chain leg stays resumable and never re-sends anything', () => {
  const resumableProceedsFailure = () => vi.fn(async () => ({ ok: false as const, resumable: true, reason: 'proceeds could not be measured: RPC timeout' }));

  it('remove-liquidity: confirmed burn + failed proceeds read -> PENDING, stays CLOSING (never reverted to ACTIVE), swap not started; resume closes without rebuilding or re-broadcasting the burn', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const position = await makeClosingPosition(positions, USDG(500));
    await exitStates.update(position.id, { pendingCloseReason: 'HARD_STOP_LOSS' });

    const firstRemove = fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: 0n }, { verifyOnChain: resumableProceedsFailure() });
    const firstSwapFactory = successfulSwapDeps();
    const first = await executeExit(position, {
      positions,
      exitStates,
      txAttempts,
      ...baseDeps({ buildRemoveLiquidityDeps: vi.fn(() => firstRemove), buildSwapDeps: firstSwapFactory }),
    });

    expect(first.outcome).toBe('PENDING');
    const afterFirst = await positions.findById(position.id);
    expect(afterFirst?.status).toBe('CLOSING');
    expect(afterFirst?.closeIdempotencyKey).toBe(position.closeIdempotencyKey);
    const removeAttempt = await txAttempts.find(`${position.closeIdempotencyKey}:removeLiquidity`);
    expect(removeAttempt?.status).toBe('CONFIRMED');
    expect(removeAttempt?.failureCode).toBeNull();
    expect(firstSwapFactory).not.toHaveBeenCalled();
    if (!afterFirst) throw new Error('unreachable');

    const resumeRemove = fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: USDG(480) });
    const second = await executeExit(afterFirst, {
      positions,
      exitStates,
      txAttempts,
      ...baseDeps({ buildRemoveLiquidityDeps: vi.fn(() => resumeRemove), buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: USDG(490), usdgProceedsRaw: USDG(490) })) }),
    });

    expect(second.outcome).toBe('CLOSED');
    expect(resumeRemove.buildTransaction).not.toHaveBeenCalled();
    expect(resumeRemove.simulate).not.toHaveBeenCalled();
    expect(resumeRemove.signTransaction).not.toHaveBeenCalled();
    expect(resumeRemove.broadcastRaw).not.toHaveBeenCalled();
    expect(resumeRemove.waitForReceipt).not.toHaveBeenCalled();
    expect(resumeRemove.verifyOnChain).toHaveBeenCalledTimes(1);
    const closed = await positions.findById(position.id);
    expect(closed?.closeReason).toBe('HARD_STOP_LOSS');
    expect(closed?.realizedUsdgRaw).toBe(USDG(970));
  });

  it('swap: confirmed, balance-verified swap + failed proceeds read -> PENDING without bumping swapAttemptCount; resume with TOKEN balance now 0 closes without re-quoting, re-approving, or re-sending', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const position = await makeClosingPosition(positions, USDG(500));
    await exitStates.update(position.id, { pendingCloseReason: 'TRAILING_TP' });
    const removeFactory = vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: USDG(480) }));

    const firstSwap = fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }, { verifyOnChain: resumableProceedsFailure() });
    const first = await executeExit(position, {
      positions,
      exitStates,
      txAttempts,
      ...baseDeps({ buildRemoveLiquidityDeps: removeFactory, buildSwapDeps: vi.fn(() => firstSwap) }),
    });

    expect(first.outcome).toBe('PENDING');
    expect((await exitStates.getOrCreate(position.id)).swapAttemptCount).toBe(0);
    const swapAttempt = await txAttempts.find(`${position.closeIdempotencyKey}:swap:0`);
    expect(swapAttempt?.status).toBe('CONFIRMED');
    expect(swapAttempt?.failureCode).toBeNull();
    const afterFirst = await positions.findById(position.id);
    expect(afterFirst?.status).toBe('CLOSING');
    if (!afterFirst) throw new Error('unreachable');

    const resumeSwap = fakeTxDeps({ usdgIncreaseRaw: USDG(490), usdgProceedsRaw: USDG(490) });
    const resumeSwapFactory = vi.fn(() => resumeSwap);
    const swapExecutor = makeSwapExecutor(makeQuote(), { needsApproval: true, spender: SPENDER });
    const readTokenBalance = vi.fn(async () => 0n); // the swap already filled
    const buildApproveDeps = successfulApproveDeps();
    const second = await executeExit(afterFirst, {
      positions,
      exitStates,
      txAttempts,
      ...baseDeps({ buildRemoveLiquidityDeps: removeFactory, buildSwapDeps: resumeSwapFactory, swapExecutor, readTokenBalance, buildApproveDeps }),
    });

    expect(second.outcome).toBe('CLOSED');
    expect(resumeSwapFactory).toHaveBeenCalledWith(position.id, TOKEN, null, swapExecutor, exitStates, { swapAttemptCount: 0 }); // stale-writer fix: resumes bound to THIS attempt number
    expect(readTokenBalance).not.toHaveBeenCalled();
    expect(swapExecutor.getQuote).not.toHaveBeenCalled();
    expect(swapExecutor.checkApproval).not.toHaveBeenCalled();
    expect(buildApproveDeps).not.toHaveBeenCalled();
    expect(resumeSwap.buildTransaction).not.toHaveBeenCalled();
    expect(resumeSwap.signTransaction).not.toHaveBeenCalled();
    expect(resumeSwap.broadcastRaw).not.toHaveBeenCalled();
    expect(resumeSwap.waitForReceipt).not.toHaveBeenCalled();
    expect(resumeSwap.verifyOnChain).toHaveBeenCalledTimes(1);
    expect((await exitStates.getOrCreate(position.id)).swapAttemptCount).toBe(0);
    expect((await positions.findById(position.id))?.realizedUsdgRaw).toBe(USDG(970));
  });

  it('swap: an interrupted receipt wait (SENT) resumes the same signed swap even though TOKEN balance already reads 0 -- no invariant throw, no second swap', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const position = await makeClosingPosition(positions, USDG(500));
    await exitStates.update(position.id, { pendingCloseReason: 'OOR_PROFIT' });
    const removeFactory = successfulRemoveDeps();

    const firstSwap = fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }, { waitForReceipt: vi.fn(async () => { throw new Error('provider dropped connection'); }) });
    const first = await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: removeFactory, buildSwapDeps: vi.fn(() => firstSwap) }) });
    expect(first.outcome).toBe('PENDING');
    expect((await txAttempts.find(`${position.closeIdempotencyKey}:swap:0`))?.status).toBe('SENT');

    const resumeSwap = fakeTxDeps({ usdgIncreaseRaw: USDG(490), usdgProceedsRaw: USDG(490) });
    const second = await executeExit(position, {
      positions,
      exitStates,
      txAttempts,
      ...baseDeps({ buildRemoveLiquidityDeps: removeFactory, buildSwapDeps: vi.fn(() => resumeSwap), readTokenBalance: vi.fn(async () => 0n) }),
    });

    expect(second.outcome).toBe('CLOSED');
    expect(resumeSwap.signTransaction).not.toHaveBeenCalled();
    expect(resumeSwap.broadcastRaw).not.toHaveBeenCalled();
    expect(resumeSwap.waitForReceipt).toHaveBeenCalledTimes(1);
  });

  it('swap: a resumed signed swap that turns out reverted is still a definitive failure -- bumps swapAttemptCount, stays CLOSING, never re-signed', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const position = await makeClosingPosition(positions, USDG(500));
    const removeFactory = successfulRemoveDeps();

    const firstSwap = fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }, { broadcastRaw: vi.fn(async () => { throw new Error('ECONNRESET'); }) });
    await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: removeFactory, buildSwapDeps: vi.fn(() => firstSwap) }) });
    expect((await txAttempts.find(`${position.closeIdempotencyKey}:swap:0`))?.status).toBe('SIGNED');

    const resumeSwap = fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }, { waitForReceipt: vi.fn(async () => ({ status: 'reverted' as const, blockNumber: 9n })) });
    const outcome = await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: removeFactory, buildSwapDeps: vi.fn(() => resumeSwap) }) });

    expect(outcome.outcome).toBe('SWAP_FAILED_RETRY_PENDING');
    expect(resumeSwap.signTransaction).not.toHaveBeenCalled();
    expect(resumeSwap.broadcastRaw).toHaveBeenCalledWith('0xdeadbeef'); // the SAME persisted signed payload, not a new one
    expect((await exitStates.getOrCreate(position.id)).swapAttemptCount).toBe(1);
    expect((await positions.findById(position.id))?.status).toBe('CLOSING');
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

      it('an AMBIGUOUS swap failure BEFORE signing does NOT advance the tier -- the resumed attempt re-quotes at the SAME width, under the SAME idempotency key', async () => {
        const positions = new InMemoryPositionRepository();
        const exitStates = new InMemoryExitStateRepository();
        const txAttempts = new InMemoryTransactionAttemptRepository();
        const position = await makeClosingPosition(positions, USDG(500));
        const { executor, bps } = recordingSwapExecutor();
        const ambiguousSwapDeps = vi.fn(() =>
          fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }, { simulate: vi.fn(async () => { throw new Error('RPC timeout'); }) }),
        );
        const deps = { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps: ambiguousSwapDeps, swapExecutor: executor }) };

        const first = await executeExit(position, deps);
        expect(first.outcome).toBe('PENDING'); // resumable, not definitive
        expect((await txAttempts.find(`${position.closeIdempotencyKey}:swap:0`))?.status).toBe('BUILT'); // nothing signed yet
        await executeExit(position, deps);

        // Widening the fill on the strength of a failure nobody has actually
        // established would be guessing, not escalating.
        expect(bps).toEqual([100, 100]);
        expect((await exitStates.getOrCreate(position.id)).swapAttemptCount).toBe(0);
      });

      it('an AMBIGUOUS swap failure AFTER signing does NOT advance the tier either -- the same signed payload is resumed, never re-quoted at any width (P1)', async () => {
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
        expect(first.outcome).toBe('PENDING');
        expect((await txAttempts.find(`${position.closeIdempotencyKey}:swap:0`))?.status).toBe('SIGNED');
        const second = await executeExit(position, deps);

        // The calldata is already signed at the tier-0 width; a fresh quote
        // could not change it, and the swap may already be on-chain.
        expect(second.outcome).toBe('PENDING');
        expect(bps).toEqual([100]);
        expect(ambiguousSwapDeps).toHaveBeenLastCalledWith(position.id, TOKEN, null, executor, exitStates, { swapAttemptCount: 0 });
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

    // H1: this used to assert that ANY zero TOKEN balance after a verified
    // remove-liquidity throws -- which stranded every never-filled one-sided
    // position at CLOSING (see the H1 describe block below). The invariant
    // it was protecting still exists, now stated precisely: the removal's
    // own receipt PROVES TOKEN was paid out, yet the wallet holds none.
    it('throws (invariant violation) if remove-liquidity VERIFIED with TOKEN proceeds > 0 but the TOKEN balance reads 0', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));

      await expect(
        executeExit(position, {
          positions,
          exitStates,
          txAttempts,
          ...baseDeps({
            buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: USDG(200), tokenProceedsRaw: USDG(3) })),
            readTokenBalance: vi.fn(async () => 0n),
          }),
        }),
      ).rejects.toThrow(/paid 3000000000000000000 TOKEN, but TOKEN balance reads 0 -- invariant violated/);
      expect((await positions.findById(position.id))?.status).toBe('CLOSING');
    });

    it('legacy attempt (no tokenProceedsRaw recorded) + TOKEN balance 0: re-reads the removal receipt, and if it shows TOKEN WAS paid, still throws the invariant', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));

      await expect(
        executeExit(position, {
          positions,
          exitStates,
          txAttempts,
          ...baseDeps({
            buildRemoveLiquidityDeps: successfulRemoveDeps(), // legacy verifyData shape: no tokenProceedsRaw
            readTokenBalance: vi.fn(async () => 0n),
            readTransfersTo: vi.fn(async (_h: `0x${string}`, token: Address) => (token === position.tokenAddress ? USDG(3) : USDG(200))),
          }),
        }),
      ).rejects.toThrow(/invariant violated/);
    });
  });

  it('P1-3: a position that is not actually CLOSING (e.g. still ACTIVE) is rejected by the resume-claim guard BEFORE reaching any transaction work -- PENDING, never a throw, never a mutation', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput());
    await positions.markActive(created.id, '1', new Date());
    const active = await positions.findById(created.id);
    if (!active) throw new Error('unreachable');

    const buildRemoveLiquidityDeps = vi.fn(() => {
      throw new Error('must never even attempt to build a transaction for a non-CLOSING position');
    });
    const outcome = await executeExit(active, {
      positions,
      exitStates,
      txAttempts,
      ...baseDeps({ buildRemoveLiquidityDeps, buildSwapDeps: successfulSwapDeps() }),
    });
    expect(outcome).toEqual({ outcome: 'PENDING', reason: 'position is already claimed by a concurrent exit/resume attempt' });
    expect(buildRemoveLiquidityDeps).not.toHaveBeenCalled();
    // The position itself is completely untouched -- still ACTIVE, no idempotency key was ever assigned.
    const reloaded = await positions.findById(created.id);
    expect(reloaded?.status).toBe('ACTIVE');
  });

  it('the internal closeIdempotencyKey guard still exists as defense-in-depth for a CLOSING position with a corrupted/missing key (a state the claim guard alone cannot rule out)', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput());
    await positions.markActive(created.id, '1', new Date());
    await positions.markClosing(created.id, `exit:${created.id}:attempt-1`);
    const closing = await positions.findById(created.id);
    if (!closing) throw new Error('unreachable');
    // Simulate data corruption: CLOSING status but a null closeIdempotencyKey -- structurally shouldn't happen via the real repo API, but the guard exists precisely because "shouldn't happen" is not "provably cannot happen."
    const corrupted = { ...closing, closeIdempotencyKey: null };

    await expect(
      executeExit(corrupted, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps: successfulSwapDeps() }),
      }),
    ).rejects.toThrow(/closeIdempotencyKey/);
  });

  describe('P1-3: CLOSING claim protection -- no duplicate close execution under concurrent workers', () => {
    it('two genuinely concurrent executeExit calls for the SAME CLOSING position: only one actually builds a transaction, the other defers as PENDING', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const position = await makeClosingPosition(positions, USDG(500));

      let buildCalls = 0;
      let releaseBuildGate: () => void = () => {};
      const buildGate = new Promise<void>((resolve) => {
        releaseBuildGate = resolve;
      });
      const buildRemoveLiquidityDeps = vi.fn(() =>
        fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: 0n }, {
          buildTransaction: vi.fn(async () => {
            buildCalls += 1;
            // Hold the FIRST caller inside its critical section until both
            // concurrent calls have been dispatched, proving the second
            // call's claim attempt genuinely races against the first
            // call's IN-PROGRESS (not yet finished) work -- not just "ran
            // strictly before/after" by accident of scheduling.
            await buildGate;
            return { to: '0x1111111111111111111111111111111111111111' as const, data: '0x' as const, value: 0n };
          }),
        }),
      );
      const buildSwapDeps = successfulSwapDeps();

      const depsShared = { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps, buildSwapDeps }) };

      const call1 = executeExit(position, depsShared);
      // Let call1 actually reach and claim the row (its claimForResume/first
      // buildTransaction invocation) before dispatching call2 -- both are
      // still concurrent in the sense that call1 has NOT finished (it's
      // blocked on buildGate) when call2 starts.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const call2 = executeExit(position, depsShared);
      await new Promise((resolve) => setTimeout(resolve, 5));

      releaseBuildGate();
      const [result1, result2] = await Promise.all([call1, call2]);

      // Exactly one of the two calls actually did transaction work; the
      // other deferred immediately via the claim guard.
      const outcomes = [result1, result2];
      const pending = outcomes.filter((o) => o.outcome === 'PENDING' && 'reason' in o && o.reason.includes('already claimed'));
      expect(pending).toHaveLength(1);
      expect(buildCalls).toBe(1); // never built twice for the same close
    });
  });
});

describe('H1: a one-sided USDG position that never filled closes cleanly after a USDG-only remove-liquidity (was: stuck at CLOSING forever)', () => {
  const USDG_ADDRESS = config.quoteAsset.ADDRESS.toLowerCase();

  function seedExitState(exitStates: InMemoryExitStateRepository, positionId: string, overrides: Partial<Parameters<InMemoryExitStateRepository['seed']>[0]> = {}) {
    exitStates.seed({
      positionId,
      pendingCloseReason: 'OOR_TIMEOUT',
      swapAttemptCount: 0,
      trailingPeakPnlPct: null,
      drawdownConfirmStartedAt: null,
      oorStartedAt: null,
      safetyExitArmedAt: null,
      maxDrawdownPnlPct: null,
      metricsFailureSince: null,
      swapUsdgBalanceBeforeRaw: null,
      swapMinOutputAmountRaw: null,
      swapVerifiedUsdgIncreaseRaw: null,
      ...overrides,
    });
  }

  /** A remove-liquidity leg that succeeds with the given receipt-measured proceeds (new verifyData shape). */
  function removeDepsPaying(usdgProceedsRaw: bigint, tokenProceedsRaw: bigint) {
    return vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw, tokenProceedsRaw }));
  }

  /** Swap/quote/balance deps that FAIL LOUDLY if touched -- a USDG-only close must never reach any of them. */
  function noSwapDeps() {
    return {
      buildSwapDeps: vi.fn(() => { throw new Error('must never build a swap for a USDG-only close'); }),
      buildApproveDeps: vi.fn(() => { throw new Error('must never approve for a USDG-only close'); }),
      swapExecutor: {
        getQuote: vi.fn(async () => { throw new Error('must never quote a nonexistent TOKEN amount'); }),
        checkApproval: vi.fn(async () => { throw new Error('must never check approval for a USDG-only close'); }),
        buildSwapTx: vi.fn(),
      } as unknown as SwapExecutor,
      // The REAL on-chain state after a USDG-only burn: 0 TOKEN in the wallet.
      readTokenBalance: vi.fn(async () => 0n),
    };
  }

  async function setup(entry = USDG(500)) {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const position = await makeClosingPosition(positions, entry);
    seedExitState(exitStates, position.id);
    return { positions, exitStates, txAttempts, position };
  }

  it('REGRESSION (the H1 bug): remove-liquidity VERIFIED, receipt pays 500 USDG and 0 TOKEN -> CLOSED with realized 500; no swap, no quote, no live TOKEN balance read (the old code threw "TOKEN balance reads 0 -- invariant violated" here, forever)', async () => {
    const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
    const deps = noSwapDeps();

    const outcome = await executeExit(position, {
      positions,
      exitStates,
      txAttempts,
      ...baseDeps({ buildRemoveLiquidityDeps: removeDepsPaying(USDG(500), 0n), ...deps }),
    });

    expect(outcome).toEqual({ outcome: 'CLOSED' });
    const closed = await positions.findById(position.id);
    expect(closed?.status).toBe('CLOSED');
    expect(closed?.closeReason).toBe('OOR_TIMEOUT');
    expect(closed?.realizedUsdgRaw).toBe(USDG(500));
    expect(deps.readTokenBalance).not.toHaveBeenCalled();
    expect(deps.swapExecutor.getQuote).not.toHaveBeenCalled();
    expect(deps.buildSwapDeps).not.toHaveBeenCalled();
    expect(await txAttempts.find(`${position.closeIdempotencyKey}:swap:0`)).toBeNull();
  });

  it('TOKEN proceeds > 0 -> the existing swap path runs unchanged (quote, swap, realized = remove USDG + swap USDG)', async () => {
    const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
    const swapExecutor = makeSwapExecutor();
    const buildSwapDeps = successfulSwapDeps(); // swap pays 100 USDG

    const outcome = await executeExit(position, {
      positions,
      exitStates,
      txAttempts,
      ...baseDeps({ buildRemoveLiquidityDeps: removeDepsPaying(USDG(200), USDG(3)), buildSwapDeps, swapExecutor, readTokenBalance: vi.fn(async () => USDG(3)) }),
    });

    expect(outcome).toEqual({ outcome: 'CLOSED' });
    expect(swapExecutor.getQuote).toHaveBeenCalledWith(TOKEN, USDG(3), 100);
    expect(buildSwapDeps).toHaveBeenCalledTimes(1);
    expect((await positions.findById(position.id))?.realizedUsdgRaw).toBe(USDG(300));
  });

  it('USDG proceeds EXACTLY equal to the entry amount -> CLOSED, realized == entry', async () => {
    const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
    const outcome = await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: removeDepsPaying(USDG(500), 0n), ...noSwapDeps() }) });
    expect(outcome).toEqual({ outcome: 'CLOSED' });
    expect((await positions.findById(position.id))?.realizedUsdgRaw).toBe(USDG(500));
  });

  it('USDG-only close whose receipt USDG exceeds the entry (USDG-denominated fees included): realized = the full receipt USDG, never reduced to the principal-only trigger PnL. NOTE: a real in-and-back-out round trip normally ALSO pays TOKEN fees (tokenProceedsRaw > 0) and takes the swap path instead -- see the TOKEN-leg tests below', async () => {
    const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
    const withFees = USDG(500) + 3_200_000_000_000_000n; // 500.0032 USDG
    const outcome = await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: removeDepsPaying(withFees, 0n), ...noSwapDeps() }) });
    expect(outcome).toEqual({ outcome: 'CLOSED' });
    expect((await positions.findById(position.id))?.realizedUsdgRaw).toBe(withFees);
  });

  it('wei-level rounding below the entry (the burn rounds down) is still a valid USDG-only close', async () => {
    const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
    const outcome = await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: removeDepsPaying(USDG(500) - 3n, 0n), ...noSwapDeps() }) });
    expect(outcome).toEqual({ outcome: 'CLOSED' });
    expect((await positions.findById(position.id))?.realizedUsdgRaw).toBe(USDG(500) - 3n);
  });

  it('ZERO USDG and zero TOKEN -> fails safe: PENDING with an anomaly warning, stays CLOSING, NOT marked CLOSED, no realized value written', async () => {
    const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
    const warnLog = vi.fn();
    const outcome = await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: removeDepsPaying(0n, 0n), warnLog, ...noSwapDeps() }) });
    expect(outcome.outcome).toBe('PENDING');
    if (outcome.outcome === 'PENDING') expect(outcome.reason).toMatch(/0 TOKEN and 0 USDG.*manual review/);
    expect(warnLog).toHaveBeenCalledWith('exit_usdg_only_close_anomaly', expect.objectContaining({ positionId: position.id }));
    const still = await positions.findById(position.id);
    expect(still?.status).toBe('CLOSING');
    expect(still?.realizedUsdgRaw).toBeNull();
  });

  it('0 TOKEN but USDG materially BELOW the one-sided floor (TOKEN that should exist is missing) -> anomaly, PENDING, stays CLOSING', async () => {
    const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
    // Floor = 500 * (1 - 1%) = 495. 400 USDG with 0 TOKEN cannot be a one-sided close.
    const outcome = await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: removeDepsPaying(USDG(400), 0n), warnLog: vi.fn(), ...noSwapDeps() }) });
    expect(outcome.outcome).toBe('PENDING');
    expect((await positions.findById(position.id))?.status).toBe('CLOSING');
  });

  it('remove-liquidity AMBIGUOUS -> unchanged: PENDING, stays CLOSING, nothing finalized', async () => {
    const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
    const outcome = await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: ambiguousRemoveDeps(), ...noSwapDeps() }) });
    expect(outcome.outcome).toBe('PENDING');
    expect((await positions.findById(position.id))?.status).toBe('CLOSING');
  });

  it('remove-liquidity DEFINITIVELY failed -> unchanged: reverted to ACTIVE (LP intact)', async () => {
    const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
    const outcome = await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: definitivelyFailingRemoveDeps(), ...noSwapDeps() }) });
    expect(outcome.outcome).toBe('REVERTED_TO_ACTIVE');
    expect((await positions.findById(position.id))?.status).toBe('ACTIVE');
  });

  describe('crash safety / idempotency', () => {
    async function persistVerifiedUsdgOnlyRemoval(txAttempts: InMemoryTransactionAttemptRepository, closeKey: string, usdg: bigint) {
      const attempt = await txAttempts.create(`${closeKey}:removeLiquidity`, 'exit:removeLiquidity');
      await txAttempts.update(attempt.id, { status: 'VERIFIED', txHash: `0x${'cd'.repeat(32)}`, verifyData: { liquidityZero: true, usdgProceedsRaw: usdg, tokenProceedsRaw: 0n } });
    }
    const neverRebuildRemove = () =>
      vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: 0n, tokenProceedsRaw: 0n }, { buildTransaction: vi.fn(async () => { throw new Error('must never rebuild an already-VERIFIED remove-liquidity'); }) }));

    it('crash AFTER remove-liquidity VERIFIED (USDG-only proceeds persisted) but BEFORE markClosed: the resume closes from the persisted receipt data -- no rebuild, no swap, realized written once', async () => {
      const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
      await persistVerifiedUsdgOnlyRemoval(txAttempts, position.closeIdempotencyKey!, USDG(501));
      const markClosed = vi.spyOn(positions, 'markClosed');

      const outcome = await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: neverRebuildRemove(), ...noSwapDeps() }) });

      expect(outcome).toEqual({ outcome: 'CLOSED' });
      expect(markClosed).toHaveBeenCalledTimes(1);
      expect((await positions.findById(position.id))?.realizedUsdgRaw).toBe(USDG(501));
    });

    it('crash DURING markClosed (the write fails): position stays CLOSING; the retry closes exactly once with the same realized amount', async () => {
      const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
      await persistVerifiedUsdgOnlyRemoval(txAttempts, position.closeIdempotencyKey!, USDG(501));
      const markClosed = vi.spyOn(positions, 'markClosed').mockRejectedValueOnce(new Error('process killed mid-write'));
      const deps = { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: neverRebuildRemove(), ...noSwapDeps() }) };

      await expect(executeExit(position, deps)).rejects.toThrow(/process killed/);
      expect((await positions.findById(position.id))?.status).toBe('CLOSING');

      const retried = await executeExit(position, deps);
      expect(retried).toEqual({ outcome: 'CLOSED' });
      expect(markClosed).toHaveBeenCalledTimes(2); // 1 failed + 1 successful -- exactly one CLOSED write
      expect((await positions.findById(position.id))?.realizedUsdgRaw).toBe(USDG(501));
    });

    it('AFTER markClosed: repeated executeExit calls (a stale CLOSING record) are no-ops -- PENDING via the claim guard, never reopened, no second close, no swap, realized unchanged', async () => {
      const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
      const deps = { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: removeDepsPaying(USDG(500), 0n), ...noSwapDeps() }) };
      expect(await executeExit(position, deps)).toEqual({ outcome: 'CLOSED' });
      const markClosed = vi.spyOn(positions, 'markClosed');

      for (let i = 0; i < 3; i++) {
        const again = await executeExit(position, deps); // `position` is the stale pre-close CLOSING snapshot
        expect(again.outcome).toBe('PENDING');
      }
      expect(markClosed).not.toHaveBeenCalled();
      const closed = await positions.findById(position.id);
      expect(closed?.status).toBe('CLOSED');
      expect(closed?.realizedUsdgRaw).toBe(USDG(500));
    });

    it('concurrency: two simultaneous executeExit calls for the same USDG-only position -> exactly one CLOSED, the other defers (existing CLOSING claim)', async () => {
      const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
      const markClosed = vi.spyOn(positions, 'markClosed');
      const deps = { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: removeDepsPaying(USDG(500), 0n), ...noSwapDeps() }) };
      const outcomes = await Promise.all([executeExit(position, deps), executeExit(position, deps)]);
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(['CLOSED', 'PENDING']);
      expect(markClosed).toHaveBeenCalledTimes(1);
    });
  });

  describe('legacy remove-liquidity attempts (verified by an older build, no tokenProceedsRaw) -- recovers positions ALREADY stuck by H1', () => {
    it('TOKEN balance 0 + the removal receipt re-read proves 0 TOKEN -> USDG-only close from the receipt', async () => {
      const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
      const readTransfersTo = vi.fn(async (_h: `0x${string}`, token: Address) => (token.toLowerCase() === USDG_ADDRESS ? USDG(500) : 0n));
      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        // legacy shape: USDG measured, TOKEN side never recorded
        ...baseDeps({ buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: USDG(500) })), ...noSwapDeps(), readTransfersTo }),
      });
      expect(outcome).toEqual({ outcome: 'CLOSED' });
      expect((await positions.findById(position.id))?.realizedUsdgRaw).toBe(USDG(500));
      expect(readTransfersTo).toHaveBeenCalledWith(`0x${'ab'.repeat(32)}`, position.tokenAddress, WALLET);
    });

    it('oldest shape (verifyData has neither proceeds field): USDG is also taken from the receipt, never fabricated', async () => {
      const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
      const attempt = await txAttempts.create(`${position.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
      await txAttempts.update(attempt.id, { status: 'VERIFIED', txHash: `0x${'ef'.repeat(32)}`, verifyData: { liquidityZero: true } });
      const readTransfersTo = vi.fn(async (_h: `0x${string}`, token: Address) => (token.toLowerCase() === USDG_ADDRESS ? USDG(502) : 0n));
      const outcome = await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), ...noSwapDeps(), readTransfersTo }) });
      expect(outcome).toEqual({ outcome: 'CLOSED' });
      expect((await positions.findById(position.id))?.realizedUsdgRaw).toBe(USDG(502));
    });

    it('receipt re-read fails -> PENDING (resumable), stays CLOSING -- never guesses', async () => {
      const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), ...noSwapDeps(), readTransfersTo: vi.fn(async () => { throw new Error('RPC down'); }) }),
      });
      expect(outcome.outcome).toBe('PENDING');
      expect((await positions.findById(position.id))?.status).toBe('CLOSING');
    });

    it('legacy attempt WITH TOKEN in the wallet -> the unchanged live-balance swap path (receipt never consulted)', async () => {
      const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
      const readTransfersTo = vi.fn();
      const outcome = await executeExit(position, {
        positions,
        exitStates,
        txAttempts,
        ...baseDeps({ buildRemoveLiquidityDeps: successfulRemoveDeps(), buildSwapDeps: successfulSwapDeps(), readTokenBalance: vi.fn(async () => USDG(2)), readTransfersTo }),
      });
      expect(outcome).toEqual({ outcome: 'CLOSED' });
      expect(readTransfersTo).not.toHaveBeenCalled();
    });
  });

  it('capital accounting across a USDG-only close (H2 model): the base stays the true 1000 before the burn and after it; once CLOSED the position leaves deployed capital and the count entirely', async () => {
    const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
    let wallet = USDG(500); // 1000 portfolio, 500 of it deployed in the LP
    const snapshotProvider = new PositionCapitalSnapshotProvider(positions, WALLET, async () => wallet, txAttempts);

    const beforeBurn = await snapshotProvider.getSnapshot(); // CLOSING, remove-liquidity not started
    expect(beforeBurn).toEqual({ freeUsdgBalance: USDG(500), totalDeployedUsdg: USDG(500), activePositionsCount: 1 });

    await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: removeDepsPaying(USDG(500), 0n), ...noSwapDeps() }) });
    wallet = USDG(1000); // the burn returned 500 USDG

    const after = await snapshotProvider.getSnapshot();
    expect(after).toEqual({ freeUsdgBalance: USDG(1000), totalDeployedUsdg: 0n, activePositionsCount: 0 }); // base 1000 = true portfolio
  });

  it('token uniqueness: once CLOSED, the same token may be entered again (CLOSED is outside the one-token-one-position set)', async () => {
    const { positions, exitStates, txAttempts, position } = await setup(USDG(500));
    await expect(positions.create(makeCreateInput({ tokenAddress: TOKEN, openIdempotencyKey: 'deploy:dup-while-closing' }))).rejects.toThrow(/already exists/);

    await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: removeDepsPaying(USDG(500), 0n), ...noSwapDeps() }) });

    const reentry = await positions.create(makeCreateInput({ tokenAddress: TOKEN, openIdempotencyKey: 'deploy:reentry-after-close' }));
    expect(reentry.status).toBe('OPENING');
  });

  it('computeRealizedProceeds (shared with the P1-13 backfill): a USDG-only removal is the whole realized amount -- no swap leg required, nothing summed twice', async () => {
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const attempt = await txAttempts.create('k:removeLiquidity', 'exit:removeLiquidity');
    await txAttempts.update(attempt.id, { status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: USDG(500), tokenProceedsRaw: 0n } });
    expect(await computeRealizedProceeds({ txAttempts }, 'k:removeLiquidity', 'k:swap:0')).toBe(USDG(500));
  });

  describe('classifyUsdgOnlyRemoval (pure)', () => {
    it('accepts exactly the 1% floor (495 of 500) and rejects one wei below it', () => {
      expect(classifyUsdgOnlyRemoval(USDG(500), USDG(495)).ok).toBe(true);
      expect(classifyUsdgOnlyRemoval(USDG(500), USDG(495) - 1n).ok).toBe(false);
    });
    it('rejects zero or negative USDG', () => {
      expect(classifyUsdgOnlyRemoval(USDG(500), 0n).ok).toBe(false);
      expect(classifyUsdgOnlyRemoval(USDG(500), -1n).ok).toBe(false);
    });
  });
});

describe('H1 follow-up: TOKEN left over after remove-liquidity (e.g. residual TOKEN fees) -- deterministic, value-preserving handling of an unactionable swap leg', () => {
  // NO dust threshold is tested here on purpose: there is no vetted, safe
  // "negligible TOKEN value" policy in this codebase (see executeExit.ts's
  // TOKEN-leg comment). Any TOKEN > 0 proven by the receipt stays on the
  // swap path; when that swap cannot be quoted/cleared, the TOKEN is
  // RETAINED and the position deterministically stays CLOSING -- never
  // discarded, never thrown, never gas-spending.
  const DUST = 37n; // 37 raw units of an 18-decimal TOKEN

  function seed(exitStates: InMemoryExitStateRepository, positionId: string) {
    exitStates.seed({
      positionId,
      pendingCloseReason: 'OOR_PROFIT',
      swapAttemptCount: 0,
      trailingPeakPnlPct: null,
      drawdownConfirmStartedAt: null,
      oorStartedAt: null,
      safetyExitArmedAt: null,
      maxDrawdownPnlPct: null,
      metricsFailureSince: null,
      swapUsdgBalanceBeforeRaw: null,
      swapMinOutputAmountRaw: null,
      swapVerifiedUsdgIncreaseRaw: null,
    });
  }

  async function setup() {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const position = await makeClosingPosition(positions, USDG(500));
    seed(exitStates, position.id);
    return { positions, exitStates, txAttempts, position };
  }

  const removePaying = (usdg: bigint, token: bigint) => vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: usdg, tokenProceedsRaw: token }));

  function rejectingSwapExecutor(message: string): SwapExecutor {
    return {
      getQuote: vi.fn(async () => { throw new Error(message); }),
      checkApproval: vi.fn(async () => { throw new Error('must never reach approval when the quote failed'); }),
      buildSwapTx: vi.fn(),
    } as unknown as SwapExecutor;
  }

  const neverBuildSwap = () => vi.fn(() => { throw new Error('must never build a swap without a quote'); });

  async function assertRetainedAndPending(
    outcome: Awaited<ReturnType<typeof executeExit>>,
    ctx: Awaited<ReturnType<typeof setup>>,
  ) {
    expect(outcome.outcome).toBe('PENDING');
    const still = await ctx.positions.findById(ctx.position.id);
    expect(still?.status).toBe('CLOSING'); // capital still counted as deployed -- conservative
    expect(still?.realizedUsdgRaw).toBeNull(); // nothing finalized, nothing discarded
    expect(await ctx.txAttempts.find(`${ctx.position.closeIdempotencyKey}:swap:0`)).toBeNull(); // no swap attempt, no gas
    expect(await ctx.txAttempts.find(`${ctx.position.closeIdempotencyKey}:approve:0`)).toBeNull();
    expect((await ctx.exitStates.getOrCreate(ctx.position.id)).swapAttemptCount).toBe(0); // not a definitive failure
  }

  it('TOKEN dust + Trading API rejects the amount -> explicit PENDING (no exception), TOKEN retained, structured warning carrying the RECEIPT amount', async () => {
    const ctx = await setup();
    const warnLog = vi.fn();
    const outcome = await executeExit(ctx.position, {
      ...ctx,
      ...baseDeps({
        buildRemoveLiquidityDeps: removePaying(USDG(500), DUST),
        readTokenBalance: vi.fn(async () => DUST),
        swapExecutor: rejectingSwapExecutor('Trading API /v1/quote failed: HTTP 400 {"errorCode":"VALIDATION_ERROR","detail":"amount too small"}'),
        buildSwapDeps: neverBuildSwap(),
        warnLog,
      }),
    });
    await assertRetainedAndPending(outcome, ctx);
    if (outcome.outcome === 'PENDING') expect(outcome.reason).toMatch(/quote unavailable for 37 TOKEN.*TOKEN retained/);
    expect(warnLog).toHaveBeenCalledWith(
      'exit_token_leg_unactionable',
      expect.objectContaining({ positionId: ctx.position.id, cause: 'QUOTE_UNAVAILABLE', receiptTokenProceedsRaw: '37', walletTokenAmountRaw: '37', tokenDecimals: 18 }),
    );
  });

  it('TOKEN dust + Trading API has no route -> the same deterministic retained PENDING', async () => {
    const ctx = await setup();
    const warnLog = vi.fn();
    const outcome = await executeExit(ctx.position, {
      ...ctx,
      ...baseDeps({
        buildRemoveLiquidityDeps: removePaying(USDG(500), DUST),
        readTokenBalance: vi.fn(async () => DUST),
        swapExecutor: rejectingSwapExecutor('Trading API /v1/quote failed: HTTP 404 {"errorCode":"ResourceNotFound","detail":"No quotes available"}'),
        buildSwapDeps: neverBuildSwap(),
        warnLog,
      }),
    });
    await assertRetainedAndPending(outcome, ctx);
    expect(warnLog).toHaveBeenCalledWith('exit_token_leg_unactionable', expect.objectContaining({ cause: 'QUOTE_UNAVAILABLE' }));
  });

  it('TOKEN dust + price impact unverifiable (provider omits it) -> the impact gate defers as before, now with a structured warning', async () => {
    const ctx = await setup();
    const warnLog = vi.fn();
    const outcome = await executeExit(ctx.position, {
      ...ctx,
      ...baseDeps({
        buildRemoveLiquidityDeps: removePaying(USDG(500), DUST),
        readTokenBalance: vi.fn(async () => DUST),
        swapExecutor: makeSwapExecutor(makeQuote({ amountInRaw: DUST, priceImpactPct: null })),
        buildSwapDeps: neverBuildSwap(),
        warnLog,
      }),
    });
    await assertRetainedAndPending(outcome, ctx);
    expect(warnLog).toHaveBeenCalledWith('exit_token_leg_unactionable', expect.objectContaining({ cause: 'PRICE_IMPACT_BLOCKED', priceImpactPct: null }));
  });

  it('retry is idempotent and bounded in cost: 5 ticks of an unroutable dust leg create no attempts, spend no gas, bump no counter; once the API routes it, the swap closes exactly once with realized = remove USDG + swap USDG (no double count)', async () => {
    const ctx = await setup();
    const removeDeps = removePaying(USDG(500), DUST);
    for (let tick = 0; tick < 5; tick++) {
      const outcome = await executeExit(ctx.position, {
        ...ctx,
        ...baseDeps({ buildRemoveLiquidityDeps: removeDeps, readTokenBalance: vi.fn(async () => DUST), swapExecutor: rejectingSwapExecutor('HTTP 404 No quotes available'), buildSwapDeps: neverBuildSwap(), warnLog: vi.fn() }),
      });
      await assertRetainedAndPending(outcome, ctx);
    }
    // The remove leg was built/broadcast exactly once across all ticks (VERIFIED short-circuit).
    const removeBroadcasts = removeDeps.mock.results.reduce((n, r) => n + ((r.value as TxSafetyDeps<unknown>).broadcastRaw as ReturnType<typeof vi.fn>).mock.calls.length, 0);
    expect(removeBroadcasts).toBe(1);

    const markClosed = vi.spyOn(ctx.positions, 'markClosed');
    const swapPays = 2_000_000_000_000n; // the dust sold for 0.000002 USDG
    const recovered = await executeExit(ctx.position, {
      ...ctx,
      ...baseDeps({
        buildRemoveLiquidityDeps: removeDeps,
        readTokenBalance: vi.fn(async () => DUST),
        swapExecutor: makeSwapExecutor(makeQuote({ amountInRaw: DUST })),
        buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: swapPays, usdgProceedsRaw: swapPays })),
      }),
    });
    expect(recovered).toEqual({ outcome: 'CLOSED' });
    expect(markClosed).toHaveBeenCalledTimes(1);
    expect((await ctx.positions.findById(ctx.position.id))?.realizedUsdgRaw).toBe(USDG(500) + swapPays);
  });

  it('TOKEN dust that the Trading API DOES route goes through the normal swap and closes -- no special-casing by amount', async () => {
    const ctx = await setup();
    const swapExecutor = makeSwapExecutor(makeQuote({ amountInRaw: DUST }));
    const outcome = await executeExit(ctx.position, {
      ...ctx,
      ...baseDeps({ buildRemoveLiquidityDeps: removePaying(USDG(500), DUST), readTokenBalance: vi.fn(async () => DUST), swapExecutor, buildSwapDeps: successfulSwapDeps() }),
    });
    expect(outcome).toEqual({ outcome: 'CLOSED' });
    expect(swapExecutor.getQuote).toHaveBeenCalledWith(TOKEN, DUST, 100);
  });

  it('MEANINGFUL TOKEN is never discarded: a quote failure for a large TOKEN amount is the same retained PENDING -- there is no amount-based bypass', async () => {
    const ctx = await setup();
    const outcome = await executeExit(ctx.position, {
      ...ctx,
      ...baseDeps({
        buildRemoveLiquidityDeps: removePaying(USDG(200), USDG(3)),
        readTokenBalance: vi.fn(async () => USDG(3)),
        swapExecutor: rejectingSwapExecutor('HTTP 503 upstream unavailable'),
        buildSwapDeps: neverBuildSwap(),
        warnLog: vi.fn(),
      }),
    });
    await assertRetainedAndPending(outcome, ctx);
  });

  it('MEANINGFUL TOKEN stays protected by the existing swap verification: a swap whose verification fails definitively is still SWAP_FAILED_RETRY_PENDING with the counter bumped (unchanged)', async () => {
    const ctx = await setup();
    const outcome = await executeExit(ctx.position, {
      ...ctx,
      ...baseDeps({
        buildRemoveLiquidityDeps: removePaying(USDG(200), USDG(3)),
        readTokenBalance: vi.fn(async () => USDG(3)),
        buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }, { verifyOnChain: vi.fn(async () => ({ ok: false as const, reason: 'swap receipt shows only 0 USDG paid' })) })),
      }),
    });
    expect(outcome.outcome).toBe('SWAP_FAILED_RETRY_PENDING');
    expect((await ctx.exitStates.getOrCreate(ctx.position.id)).swapAttemptCount).toBe(1);
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });

  it('the RECEIPT, not the wallet, decides: receipt TOKEN = 0 closes USDG-only even while the wallet holds unrelated TOKEN, which is never read, quoted, or swapped', async () => {
    const ctx = await setup();
    const readTokenBalance = vi.fn(async () => USDG(999)); // unrelated TOKEN already sitting in the wallet
    const swapExecutor = makeSwapExecutor();
    const outcome = await executeExit(ctx.position, {
      ...ctx,
      ...baseDeps({ buildRemoveLiquidityDeps: removePaying(USDG(500), 0n), readTokenBalance, swapExecutor, buildSwapDeps: neverBuildSwap() }),
    });
    expect(outcome).toEqual({ outcome: 'CLOSED' });
    expect(readTokenBalance).not.toHaveBeenCalled();
    expect(swapExecutor.getQuote).not.toHaveBeenCalled();
    expect((await ctx.positions.findById(ctx.position.id))?.realizedUsdgRaw).toBe(USDG(500));
  });

  it('the RECEIPT, not the wallet, decides the other way too: receipt TOKEN = 1 wei is NOT USDG-only -- it takes the swap path even though the USDG alone clears the floor', async () => {
    const ctx = await setup();
    const swapExecutor = makeSwapExecutor(makeQuote({ amountInRaw: 1n }));
    const outcome = await executeExit(ctx.position, {
      ...ctx,
      ...baseDeps({ buildRemoveLiquidityDeps: removePaying(USDG(500), 1n), readTokenBalance: vi.fn(async () => 1n), swapExecutor, buildSwapDeps: successfulSwapDeps() }),
    });
    expect(outcome).toEqual({ outcome: 'CLOSED' });
    expect(swapExecutor.getQuote).toHaveBeenCalledTimes(1);
  });
});

describe('H2: capital accounting across the REAL exit lifecycle (executeExit + PositionCapitalSnapshotProvider over the same repositories)', () => {
  // True portfolio 1000. The position (entry 500) is CLOSING; wallet holds the other 500.
  // The remove-liquidity burn returns 300 USDG + 3 TOKEN (the TOKEN's unrecovered cost basis is 200).
  const TRUE = USDG(1000);

  async function setupLifecycle() {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const position = await makeClosingPosition(positions, USDG(500));
    exitStates.seed({
      positionId: position.id,
      pendingCloseReason: 'HARD_STOP_LOSS',
      swapAttemptCount: 0,
      trailingPeakPnlPct: null,
      drawdownConfirmStartedAt: null,
      oorStartedAt: null,
      safetyExitArmedAt: null,
      maxDrawdownPnlPct: null,
      metricsFailureSince: null,
      swapUsdgBalanceBeforeRaw: null,
      swapMinOutputAmountRaw: null,
      swapVerifiedUsdgIncreaseRaw: null,
    });
    const chain = { wallet: USDG(500) };
    const provider = new PositionCapitalSnapshotProvider(positions, WALLET, async () => chain.wallet, txAttempts);
    return { positions, exitStates, txAttempts, position, chain, provider };
  }

  const removeReturning = (usdg: bigint, token: bigint) => vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: usdg, tokenProceedsRaw: token }));
  const quoteFails = () => ({ getQuote: vi.fn(async () => { throw new Error('HTTP 404 No quotes available'); }), checkApproval: vi.fn(), buildSwapTx: vi.fn() }) as unknown as SwapExecutor;

  it('CLOSING before remove -> after verified remove with TOKEN pending: the base stays the TRUE 1000 (returned 300 counted once, the 200 TOKEN cost basis stays deployed)', async () => {
    const ctx = await setupLifecycle();
    expect(await ctx.provider.getSnapshot()).toEqual({ freeUsdgBalance: USDG(500), totalDeployedUsdg: USDG(500), activePositionsCount: 1 });

    const outcome = await executeExit(ctx.position, { ...ctx, ...baseDeps({ buildRemoveLiquidityDeps: removeReturning(USDG(300), USDG(3)), readTokenBalance: vi.fn(async () => USDG(3)), swapExecutor: quoteFails(), warnLog: vi.fn() }) });
    expect(outcome.outcome).toBe('PENDING'); // swap leg unactionable this tick
    ctx.chain.wallet = USDG(800);

    const s = await ctx.provider.getSnapshot();
    expect(s).toEqual({ freeUsdgBalance: USDG(800), totalDeployedUsdg: USDG(200), activePositionsCount: 1 });
    expect(s.freeUsdgBalance + s.totalDeployedUsdg).toBe(TRUE); // pre-H2: 800 + 500 = 1300
  });

  it('quote-unavailable deferrals: 5 ticks later the snapshot is identical -- free capital never inflates', async () => {
    const ctx = await setupLifecycle();
    const deps = { ...ctx, ...baseDeps({ buildRemoveLiquidityDeps: removeReturning(USDG(300), USDG(3)), readTokenBalance: vi.fn(async () => USDG(3)), swapExecutor: quoteFails(), warnLog: vi.fn() }) };
    await executeExit(ctx.position, deps);
    ctx.chain.wallet = USDG(800);
    const first = await ctx.provider.getSnapshot();
    for (let tick = 0; tick < 5; tick++) {
      expect((await executeExit(ctx.position, deps)).outcome).toBe('PENDING');
      expect(await ctx.provider.getSnapshot()).toEqual(first);
    }
  });

  it('price-impact deferrals: repeated ticks leave the snapshot identical too', async () => {
    const ctx = await setupLifecycle();
    const deps = { ...ctx, ...baseDeps({ buildRemoveLiquidityDeps: removeReturning(USDG(300), USDG(3)), readTokenBalance: vi.fn(async () => USDG(3)), swapExecutor: makeSwapExecutor(makeQuote({ priceImpactPct: null })), warnLog: vi.fn() }) };
    await executeExit(ctx.position, deps);
    ctx.chain.wallet = USDG(800);
    const first = await ctx.provider.getSnapshot();
    for (let tick = 0; tick < 5; tick++) {
      expect((await executeExit(ctx.position, deps)).outcome).toBe('PENDING');
      expect(await ctx.provider.getSnapshot()).toEqual(first);
    }
    expect(first.freeUsdgBalance + first.totalDeployedUsdg).toBe(TRUE);
  });

  it('successful swap -> CLOSED: capital moves out of deployed exactly once; afterwards base = wallet (the realized result), slot freed', async () => {
    const ctx = await setupLifecycle();
    const markClosed = vi.spyOn(ctx.positions, 'markClosed');
    await executeExit(ctx.position, { ...ctx, ...baseDeps({ buildRemoveLiquidityDeps: removeReturning(USDG(300), USDG(3)), readTokenBalance: vi.fn(async () => USDG(3)), swapExecutor: quoteFails(), warnLog: vi.fn() }) });
    ctx.chain.wallet = USDG(800);

    const swapPays = USDG(190);
    const outcome = await executeExit(ctx.position, {
      ...ctx,
      ...baseDeps({ buildRemoveLiquidityDeps: removeReturning(USDG(300), USDG(3)), readTokenBalance: vi.fn(async () => USDG(3)), buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: swapPays, usdgProceedsRaw: swapPays })) }),
    });
    expect(outcome).toEqual({ outcome: 'CLOSED' });
    ctx.chain.wallet = USDG(990);
    expect(markClosed).toHaveBeenCalledTimes(1);
    expect(await ctx.provider.getSnapshot()).toEqual({ freeUsdgBalance: USDG(990), totalDeployedUsdg: 0n, activePositionsCount: 0 });
  });

  it('crash after the swap VERIFIED but before markClosed: the still-CLOSING position contributes 0 -- remove AND swap proceeds are both already in the wallet, neither is counted again', async () => {
    const ctx = await setupLifecycle();
    const removeKey = `${ctx.position.closeIdempotencyKey}:removeLiquidity`;
    const r = await ctx.txAttempts.create(removeKey, 'exit:removeLiquidity');
    await ctx.txAttempts.update(r.id, { status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: USDG(300), tokenProceedsRaw: USDG(3) } });
    const sw = await ctx.txAttempts.create(`${ctx.position.closeIdempotencyKey}:swap:0`, 'exit:swap');
    await ctx.txAttempts.update(sw.id, { status: 'VERIFIED', verifyData: { usdgIncreaseRaw: USDG(190), usdgProceedsRaw: USDG(190) } });
    ctx.chain.wallet = USDG(990);
    expect(await ctx.provider.getSnapshot()).toEqual({ freeUsdgBalance: USDG(990), totalDeployedUsdg: 0n, activePositionsCount: 1 });
  });

  it('an AMBIGUOUS remove-liquidity (broadcast uncertain: SIGNED/SENT in the DB, maybe mined) makes the snapshot unresolved and the allocator refuses; once the resume verifies it, accounting resolves to the true base', async () => {
    const ctx = await setupLifecycle();
    const ambiguous = await executeExit(ctx.position, { ...ctx, ...baseDeps({ buildRemoveLiquidityDeps: ambiguousRemoveDeps(), warnLog: vi.fn() }) });
    expect(ambiguous.outcome).toBe('PENDING');
    ctx.chain.wallet = USDG(800); // the tx may in fact have landed

    const unresolved = await ctx.provider.getSnapshot();
    expect(unresolved.accountingUnresolvedReason).toMatch(/removeLiquidity is (SIGNED|SENT)/);
    expect(decideCapitalAllocation(unresolved, config.rules.capital).ok).toBe(false);

    // Resume: the receipt is found and verification completes.
    await executeExit(ctx.position, {
      ...ctx,
      ...baseDeps({
        buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: USDG(300), tokenProceedsRaw: USDG(3) }, { getReceiptIfAvailable: vi.fn(async () => ({ status: 'success' as const, blockNumber: 9n })) })),
        readTokenBalance: vi.fn(async () => USDG(3)),
        swapExecutor: quoteFails(),
        warnLog: vi.fn(),
      }),
    });
    const resolved = await ctx.provider.getSnapshot();
    expect(resolved.accountingUnresolvedReason).toBeUndefined();
    expect(resolved.freeUsdgBalance + resolved.totalDeployedUsdg).toBe(TRUE);
  });

  it('failed exit / retry: a definitive remove failure reverts to ACTIVE (full entry deployed, nothing lost); the NEXT close uses a fresh key and the old attempts are ignored', async () => {
    const ctx = await setupLifecycle();
    const reverted = await executeExit(ctx.position, { ...ctx, ...baseDeps({ buildRemoveLiquidityDeps: definitivelyFailingRemoveDeps() }) });
    expect(reverted.outcome).toBe('REVERTED_TO_ACTIVE');
    expect(await ctx.provider.getSnapshot()).toEqual({ freeUsdgBalance: USDG(500), totalDeployedUsdg: USDG(500), activePositionsCount: 1 });

    await ctx.positions.markClosing(ctx.position.id, `exit:${ctx.position.id}:attempt-2`);
    const again = await ctx.positions.findById(ctx.position.id);
    expect(await ctx.provider.getSnapshot()).toEqual({ freeUsdgBalance: USDG(500), totalDeployedUsdg: USDG(500), activePositionsCount: 1 }); // new close, nothing started
    await executeExit(again!, { ...ctx, ...baseDeps({ buildRemoveLiquidityDeps: removeReturning(USDG(300), USDG(3)), readTokenBalance: vi.fn(async () => USDG(3)), swapExecutor: quoteFails(), warnLog: vi.fn() }) });
    ctx.chain.wallet = USDG(800);
    const s = await ctx.provider.getSnapshot();
    expect(s.freeUsdgBalance + s.totalDeployedUsdg).toBe(TRUE);
  });

  it('restart: a brand-new provider over the same persisted rows/attempts reconstructs the identical snapshot', async () => {
    const ctx = await setupLifecycle();
    await executeExit(ctx.position, { ...ctx, ...baseDeps({ buildRemoveLiquidityDeps: removeReturning(USDG(300), USDG(3)), readTokenBalance: vi.fn(async () => USDG(3)), swapExecutor: quoteFails(), warnLog: vi.fn() }) });
    ctx.chain.wallet = USDG(800);
    const before = await ctx.provider.getSnapshot();
    const restarted = new PositionCapitalSnapshotProvider(ctx.positions, WALLET, async () => ctx.chain.wallet, ctx.txAttempts);
    expect(await restarted.getSnapshot()).toEqual(before);
  });

  it('the write-time re-check (createIfCapitalAllows) uses the SAME H2 accounting: with the returned USDG in the wallet, an entry pre-sized off the old inflated base is rejected, a correctly-sized one is accepted', async () => {
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const positions = new InMemoryPositionRepository(txAttempts);
    const exitStates = new InMemoryExitStateRepository();
    const position = await makeClosingPosition(positions, USDG(350));
    await executeExit(position, { positions, exitStates, txAttempts, ...baseDeps({ buildRemoveLiquidityDeps: removeReturning(USDG(345), 5n), readTokenBalance: vi.fn(async () => 5n), swapExecutor: quoteFails(), warnLog: vi.fn() }) });
    const wallet = USDG(995); // true portfolio 1000: 995 USDG + 5-wei-of-TOKEN leg carried at 5 USDG cost

    const inflated = await positions.createIfCapitalAllows(makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000c7', entryUsdgRaw: USDG(470), openIdempotencyKey: 'deploy:c7:1' }), async () => wallet, config.rules.capital);
    expect(inflated.ok).toBe(false); // the pre-H2 base 995 + 350 = 1345 would have allowed ~470
    const correct = await positions.createIfCapitalAllows(makeCreateInput({ tokenAddress: '0x00000000000000000000000000000000000000c8', entryUsdgRaw: USDG(350), openIdempotencyKey: 'deploy:c8:1' }), async () => wallet, config.rules.capital);
    expect(correct.ok).toBe(true);
  });
});

describe('Same-attempt swap race -- executeExit treats a lost attempt ownership as PENDING (no gas, no failure count) and surfaces it once', () => {
  it('a swap leg that stops because another worker owns the attempt -> PENDING, swapAttemptCount unchanged, exit_swap_attempt_ownership_lost logged', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const position = await makeClosingPosition(positions, USDG(500));
    const warnLog = vi.fn();
    const broadcastRaw = vi.fn(async () => undefined);
    const outcome = await executeExit(position, {
      positions,
      exitStates,
      txAttempts,
      ...baseDeps({
        buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: USDG(200), tokenProceedsRaw: USDG(3) })),
        readTokenBalance: vi.fn(async () => USDG(3)),
        buildSwapDeps: vi.fn(() =>
          fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }, {
            buildTransaction: vi.fn(async () => { throw new Error('exit swap for position x: swap attempt 0 is no longer current (now 1) -- stale worker, not building'); }),
            broadcastRaw,
          }),
        ),
        warnLog,
      }),
    });
    expect(outcome.outcome).toBe('PENDING');
    expect(broadcastRaw).not.toHaveBeenCalled();
    expect((await exitStates.getOrCreate(position.id)).swapAttemptCount).toBe(0);
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(warnLog).toHaveBeenCalledWith('exit_swap_attempt_ownership_lost', expect.objectContaining({ positionId: position.id, swapKey: `${position.closeIdempotencyKey}:swap:0` }));
  });
});

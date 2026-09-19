import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { runExitCycle } from '../../src/exits/runExitCycle';
import type { LivePositionStateProvider } from '../../src/monitoring/types';
import { ExitStateMonotonicityError, EMPTY_EXIT_STATE } from '../../src/exits/types';
import type { SwapExecutor } from '../../src/swap/types';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemorySettingsRepository } from '../settings/inMemorySettingsRepository';
import { deriveEntryLiquidity, ENTRY_TICK, liveState, livePriceState } from './positionFixture';
import { makeCreateInput } from '../positions/fixtures';

// Stale-writer fix: deterministic concurrency tests. Coordination is by
// explicit latches (deferred promises), never by sleeps: worker A is paused
// at a known point AFTER it has read its ExitState snapshot, worker B writes,
// then A is released and must not be able to overwrite B's newer state.

const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;
const LIQUIDITY = deriveEntryLiquidity();
const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };
const T_ARMED = new Date('2026-09-18T01:00:00Z');

function latch(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}

function fakeTxDeps<T>(data: T): TxSafetyDeps<T> {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 7),
    signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'cd'.repeat(32)}` as `0x${string}` })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data })),
  };
}

const swapExecutor: SwapExecutor = {
  getQuote: vi.fn(async () => ({ amountInRaw: USDG(1), expectedAmountOutRaw: USDG(1), minOutputAmountRaw: 0n, priceImpactPct: 0.001, slippageBps: 100, providerQuote: {} })),
  checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })),
  buildSwapTx: vi.fn(),
};

/** Shared "database" (the repositories) + a per-worker deps factory -- two workers = two runExitCycle calls over the SAME repositories. */
async function sharedStore(seed: Partial<typeof EMPTY_EXIT_STATE> = {}) {
  const positions = new InMemoryPositionRepository();
  const exitStates = new InMemoryExitStateRepository();
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
  await positions.markActive(created.id, '1', new Date());
  exitStates.seed({ positionId: created.id, ...EMPTY_EXIT_STATE, ...seed });
  const workerDeps = (tick: number, livePositionState?: LivePositionStateProvider) => ({
    positions,
    exitStates,
    txAttempts,
    livePositionState: livePositionState ?? { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) },
    poolPrice: { getPriceState: vi.fn(async () => livePriceState(tick)) },
    swapExecutor,
    settings: new InMemorySettingsRepository(),
    buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: USDG(100), tokenProceedsRaw: 0n })),
    buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n })),
    readTokenBalance: vi.fn(async () => 0n),
    readAllowance: vi.fn(async () => 0n),
    walletAddress: WALLET,
  });
  return { positions, exitStates, txAttempts, id: created.id, workerDeps };
}

/** A live-state reader that parks the calling worker (after it read its ExitState snapshot) until released. */
function parkedLiveState() {
  const entered = latch();
  const gate = latch();
  const provider: LivePositionStateProvider = {
    getLiveState: vi.fn(async () => {
      entered.release();
      await gate.wait;
      return liveState(LIQUIDITY);
    }),
  };
  return { provider, entered: entered.wait, release: gate.release };
}

describe('ExitState stale-writer fix -- the REAL runExitCycle orchestrator, two workers racing on one position', () => {
  it('(1) A reads {swapAttemptCount 3, safetyExitArmedAt T}; B increments to 4; A\'s stale decision write is rejected -- the count stays 4 and the armed safety exit stays set', async () => {
    const store = await sharedStore({ swapAttemptCount: 3, safetyExitArmedAt: T_ARMED, maxDrawdownPnlPct: -0.09 });
    const parked = parkedLiveState();
    const workerA = runExitCycle(store.workerDeps(ENTRY_TICK, parked.provider));
    await parked.entered; // A holds its snapshot (version 1)

    // Worker B (another process): a definitive swap failure recorded for attempt 3.
    expect(await store.exitStates.incrementSwapAttemptFrom(store.id, 3)).toBe(true);
    parked.release();
    const resultsA = await workerA;

    expect(resultsA).toEqual([{ positionId: store.id, action: 'NONE', outcome: { outcome: 'PENDING', reason: expect.stringMatching(/stale snapshot/) } }]);
    const final = await store.exitStates.getOrCreate(store.id);
    expect(final.swapAttemptCount).toBe(4); // pre-fix: A's full-object write reverted this to 3
    expect(final.safetyExitArmedAt).toEqual(T_ARMED);
    expect(final.maxDrawdownPnlPct).toBe(-0.09);
  });

  it('(2+3) two workers both see a HARD_STOP: A is parked; B arms nothing new, writes the close reason and starts the exit; A\'s stale write is rejected and A NEVER re-keys or restarts the exit (CLOSING is not moved back)', async () => {
    const store = await sharedStore();
    const parked = parkedLiveState();
    const workerA = runExitCycle(store.workerDeps(-3000, parked.provider));
    await parked.entered;

    const resultsB = await runExitCycle(store.workerDeps(-3000));
    expect(resultsB[0]).toMatchObject({ positionId: store.id, action: 'CLOSE_STARTED' });
    const afterB = await store.positions.findById(store.id);
    const bKey = afterB!.closeIdempotencyKey;
    expect(bKey).not.toBeNull();

    parked.release();
    const resultsA = await workerA;
    expect(resultsA[0]).toMatchObject({ positionId: store.id, action: 'NONE', outcome: { outcome: 'PENDING' } });
    const afterA = await store.positions.findById(store.id);
    expect(afterA!.closeIdempotencyKey).toBe(bKey); // never re-keyed by the stale worker
    expect(afterA!.status).not.toBe('ACTIVE');
    expect((await store.exitStates.getOrCreate(store.id)).pendingCloseReason).toBe('HARD_STOP_LOSS');
  });

  it('(5) a stale worker cannot clear an armed safety exit: A read BEFORE arming, B armed it; A\'s write is rejected. Even a write at the CURRENT version may not clear or re-date it', async () => {
    const store = await sharedStore();
    const snapshotA = await store.exitStates.getOrCreate(store.id); // version 1, not armed
    const armed = await store.exitStates.updateDecisionState(store.id, snapshotA.version, { safetyExitArmedAt: T_ARMED, maxDrawdownPnlPct: -0.085 });
    expect(armed).not.toBeNull();

    expect(await store.exitStates.updateDecisionState(store.id, snapshotA.version, { safetyExitArmedAt: null, maxDrawdownPnlPct: -0.01 })).toBeNull();
    await expect(store.exitStates.updateDecisionState(store.id, armed!.version, { safetyExitArmedAt: null })).rejects.toBeInstanceOf(ExitStateMonotonicityError);
    await expect(store.exitStates.updateDecisionState(store.id, armed!.version, { safetyExitArmedAt: new Date(T_ARMED.getTime() + 1) })).rejects.toBeInstanceOf(ExitStateMonotonicityError);
    await expect(store.exitStates.updateDecisionState(store.id, armed!.version, { maxDrawdownPnlPct: -0.02 })).rejects.toBeInstanceOf(ExitStateMonotonicityError);
    expect((await store.exitStates.getOrCreate(store.id)).safetyExitArmedAt).toEqual(T_ARMED);
  });
});

describe('ExitState stale-writer fix -- repository-level guarantees (in-memory double mirrors the real repository)', () => {
  it('(8) concurrent increments: two workers recording the SAME failure advance the counter ONCE; successive failures each count', async () => {
    const store = await sharedStore({ swapAttemptCount: 0 });
    const same = await Promise.all([store.exitStates.incrementSwapAttemptFrom(store.id, 0), store.exitStates.incrementSwapAttemptFrom(store.id, 0)]);
    expect(same.filter(Boolean)).toHaveLength(1);
    expect((await store.exitStates.getOrCreate(store.id)).swapAttemptCount).toBe(1);
    expect(await store.exitStates.incrementSwapAttemptFrom(store.id, 1)).toBe(true);
    expect((await store.exitStates.getOrCreate(store.id)).swapAttemptCount).toBe(2);
  });

  it('(9) concurrent failure information is never lost: a stale swap-leg worker (older attempt) cannot overwrite the newer attempt\'s baseline; the newer attempt\'s increment survives', async () => {
    const store = await sharedStore({ swapAttemptCount: 1 });
    expect(await store.exitStates.updateSwapLegFields(store.id, 1, { swapMinOutputAmountRaw: 111n })).toBe(true);
    expect(await store.exitStates.incrementSwapAttemptFrom(store.id, 1)).toBe(true); // attempt 1 failed
    expect(await store.exitStates.updateSwapLegFields(store.id, 2, { swapMinOutputAmountRaw: 222n })).toBe(true); // attempt 2 begins
    // A worker still on attempt 1 tries to write its baseline now:
    expect(await store.exitStates.updateSwapLegFields(store.id, 1, { swapMinOutputAmountRaw: 999n, swapUsdgBalanceBeforeRaw: 5n })).toBe(false);
    const final = await store.exitStates.getOrCreate(store.id);
    expect(final).toMatchObject({ swapAttemptCount: 2, swapMinOutputAmountRaw: 222n });
  });

  it('(6+7) stale lifecycle writers never move a position backwards: markActive/markClosing on CLOSING, markExitFailed with an old close key, and anything on CLOSED all write nothing', async () => {
    const store = await sharedStore();
    const closing = await store.positions.markClosing(store.id, 'exit:new');
    expect(closing?.status).toBe('CLOSING');
    expect(await store.positions.markClosing(store.id, 'exit:stale')).toBeNull();
    expect(await store.positions.markActive(store.id, '999', new Date())).toBeNull();
    expect(await store.positions.markExitFailed(store.id, 'exit:old-close')).toBeNull();
    expect((await store.positions.findById(store.id))).toMatchObject({ status: 'CLOSING', closeIdempotencyKey: 'exit:new', positionTokenId: '1' });

    expect(await store.positions.markClosed(store.id, new Date(), 'HARD_TP', 5n, 'exit:new')).not.toBeNull();
    expect(await store.positions.markExitFailed(store.id, 'exit:new')).toBeNull(); // CLOSED is never reopened
    expect(await store.positions.markClosing(store.id, 'exit:again')).toBeNull();
    expect(await store.positions.markActive(store.id, '2', new Date())).toBeNull();
    expect(await store.positions.markClosed(store.id, new Date(), 'OOR_TIMEOUT', 1n)).toBeNull(); // no second close / proceeds overwrite
    expect(await store.positions.findById(store.id)).toMatchObject({ status: 'CLOSED', closeReason: 'HARD_TP', realizedUsdgRaw: 5n });
  });

  it('(10) restart: a fresh repository instance seeded from persisted state keeps the version, the counter and the sticky arming -- a pre-restart snapshot is still rejected', async () => {
    const store = await sharedStore({ swapAttemptCount: 2, safetyExitArmedAt: T_ARMED });
    const before = await store.exitStates.getOrCreate(store.id);
    await store.exitStates.updateDecisionState(store.id, before.version, { oorStartedAt: T_ARMED });
    const persisted = await store.exitStates.getOrCreate(store.id);

    const restarted = new InMemoryExitStateRepository();
    restarted.seed(persisted); // as read back after a restart
    const reread = await restarted.getOrCreate(store.id);
    expect(reread).toEqual(persisted);
    expect(await restarted.updateDecisionState(store.id, before.version, { oorStartedAt: null })).toBeNull();
  });
});

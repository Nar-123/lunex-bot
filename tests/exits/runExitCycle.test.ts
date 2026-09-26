import { describe, expect, it, vi } from 'vitest';
import { runExitCycle } from '../../src/exits/runExitCycle';
import type { RunExitCycleDeps } from '../../src/exits/runExitCycle';
import type { LivePositionStateProvider, PoolPriceProvider } from '../../src/monitoring/types';
import { config } from '../../src/config';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemorySettingsRepository } from '../settings/inMemorySettingsRepository';
import { deriveEntryLiquidity, ENTRY_TICK, liveState, livePriceState, makeExitTestPosition } from './positionFixture';
import { makeCreateInput } from '../positions/fixtures';
import type { SwapExecutor } from '../../src/swap/types';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import type { Address } from 'viem';
import { grantAlreadyValid } from '../exits/tokenGrantTestStub';

const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;
const LIQUIDITY = deriveEntryLiquidity();

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

const fakeSwapExecutor: SwapExecutor = {
  getQuote: vi.fn(async () => ({ amountInRaw: USDG(0), expectedAmountOutRaw: USDG(0), minOutputAmountRaw: 0n, priceImpactPct: 0.001, slippageBps: 100, providerQuote: { fake: true } })),
  checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })),
  buildSwapTx: vi.fn(),
};

async function makeDeps(overrides: { livePositionState?: LivePositionStateProvider; poolPrice?: PoolPriceProvider } = {}) {
  const positions = new InMemoryPositionRepository();
  const exitStates = new InMemoryExitStateRepository();
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const livePositionState: LivePositionStateProvider = overrides.livePositionState ?? { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) };
  const poolPrice: PoolPriceProvider = overrides.poolPrice ?? { getPriceState: vi.fn(async () => livePriceState(ENTRY_TICK)) };
  return {
    positions,
    exitStates,
    txAttempts,
    livePositionState,
    poolPrice,
    swapExecutor: fakeSwapExecutor,
    tokenGrantPreflight: grantAlreadyValid,
    settings: new InMemorySettingsRepository(),
    buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: 0n, tokenProceedsRaw: USDG(100) })),
    buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n })),
    readTokenBalance: vi.fn(async () => USDG(100)),
    readAllowance: vi.fn(async () => 10n ** 30n), // HIGH-1: TOKEN->Permit2 allowance already sufficient, so the approve leg is skipped (it is not this test's subject)
    walletAddress: WALLET,
  };
}

describe('runExitCycle -- C4 regression: pendingCloseReason is written BEFORE markClosing', () => {
  it('a crash simulated exactly at markClosing still leaves pendingCloseReason recorded -- CLOSING+null is now unreachable', async () => {
    const deps = await makeDeps({
      livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) },
      // -3000 -> pnlPct ~ -6.4%: in the un-armed Hard-Stop band (between
      // -6% and Safety Exit's -8% arming threshold, see P0-3), so Hard
      // Stop fires cleanly without Safety Exit arming same-tick.
      poolPrice: { getPriceState: vi.fn(async () => livePriceState(-3000)) }, // triggers HARD_STOP_LOSS
    });
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await deps.positions.markActive(created.id, '1', new Date());

    // Simulates a crash landing exactly at the markClosing call -- the
    // OLD write order (markClosing first, pendingCloseReason second)
    // would leave this position at CLOSING with pendingCloseReason still
    // null. The fix reverses the order, so this must NEVER happen.
    deps.positions.markClosing = vi.fn(async () => {
      throw new Error('simulated crash at markClosing');
    });

    const results = await runExitCycle(deps);
    expect(results[0]?.action).toBe('NONE'); // caught by the per-position try/catch

    const exitState = await deps.exitStates.getOrCreate(created.id);
    expect(exitState.pendingCloseReason).toBe('HARD_STOP_LOSS'); // persisted BEFORE the crash

    const reloaded = await deps.positions.findById(created.id);
    expect(reloaded?.status).toBe('ACTIVE'); // never reached CLOSING at all -- CLOSING+null is structurally impossible now
  });
});

describe('runExitCycle', () => {
  it('a position at breakeven (no trigger conditions met) is left ACTIVE, untouched', async () => {
    const deps = await makeDeps();
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await deps.positions.markActive(created.id, '1', new Date());

    const results = await runExitCycle(deps);

    expect(results).toEqual([{ positionId: created.id, action: 'NONE' }]);
    const reloaded = await deps.positions.findById(created.id);
    expect(reloaded?.status).toBe('ACTIVE');
  });

  describe('priority wiring: a real deep price crash that is BOTH well past HARD_STOP_LOSS AND already past the 30-min OOR grace window', () => {
    it('P0-3: a deep same-tick crash arms SAFETY_EXIT instead of HARD_STOP_LOSS closing at the crash price', async () => {
      // For THIS position's range geometry, by the time price has moved
      // far enough to be genuinely out of range, PnL has already fallen
      // well past Safety Exit's -8% arming threshold too -- there is no
      // tick where this position is simultaneously "out of range" and
      // "only -6%-to-8% down." Under the P0-3 fix, a crash this deep arms
      // SAFETY_EXIT same-tick rather than HARD_STOP_LOSS closing
      // immediately at the crash price -- see resolveExitDecision.ts's
      // doc comment. No OOR timer pre-seeded here (that interaction is
      // covered, and deliberately left as pre-existing/out-of-scope
      // behavior, in the test below).
      const deps = await makeDeps({
        livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) },
        poolPrice: { getPriceState: vi.fn(async () => livePriceState(-7000)) }, // pnlPct ~ -0.29 (past -15%), inRange: false
      });
      const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
      await deps.positions.markActive(created.id, '1', new Date());

      const results = await runExitCycle(deps);

      expect(results).toHaveLength(1);
      expect(results[0]?.action).toBe('NONE'); // armed, not closed -- waiting for recovery to breakeven

      const reloaded = await deps.positions.findById(created.id);
      expect(reloaded?.status).toBe('ACTIVE'); // NOT stopped out at the crash price
      const exitState = await deps.exitStates.getOrCreate(created.id);
      expect(exitState.safetyExitArmedAt).not.toBeNull(); // SAFETY_EXIT armed instead
    });

    it('KNOWN, PRE-EXISTING, OUT-OF-P0-3-SCOPE interaction: an armed-but-not-yet-recovered Safety Exit does NOT block a lower-priority rule (e.g. OOR_TIMEOUT) that independently qualifies the SAME tick -- this is how the ladder already worked for any armed-without-closing state (e.g. under a widened hardStopLossPct) and is unchanged by P0-3', async () => {
      const deps = await makeDeps({
        livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) },
        poolPrice: { getPriceState: vi.fn(async () => livePriceState(-7000)) }, // pnlPct ~ -0.29, inRange: false
      });
      const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000010' }));
      await deps.positions.markActive(created.id, '1', new Date());
      await deps.exitStates.update(created.id, { oorStartedAt: new Date(Date.now() - 40 * 60 * 1000) });

      const results = await runExitCycle(deps);
      expect(results[0]?.action).toBe('CLOSE_STARTED');
      const reloaded = await deps.positions.findById(created.id);
      expect(reloaded?.closeReason).toBe('OOR_TIMEOUT');
    });

    it('a shallower drop (-6.4%, still in-range) that is ALSO past the OOR grace window still closes for HARD_STOP_LOSS, not OOR', async () => {
      // Complements the test above: proves rule-1's priority over OOR is
      // still intact for the band that does NOT arm Safety Exit.
      const deps = await makeDeps({
        livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) },
        poolPrice: { getPriceState: vi.fn(async () => livePriceState(-3000)) }, // pnlPct ~ -6.4%, inRange: true
      });
      const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000009' }));
      await deps.positions.markActive(created.id, '1', new Date());
      await deps.exitStates.update(created.id, { oorStartedAt: new Date(Date.now() - 40 * 60 * 1000) });

      const results = await runExitCycle(deps);

      expect(results).toHaveLength(1);
      expect(results[0]?.action).toBe('CLOSE_STARTED');
      expect(results[0]?.outcome).toEqual({ outcome: 'CLOSED' });

      const reloaded = await deps.positions.findById(created.id);
      expect(reloaded?.status).toBe('CLOSED');
      expect(reloaded?.closeReason).toBe('HARD_STOP_LOSS');
    });
  });

  it('persists the fresh live-metrics-derived exit state (e.g. a newly-armed Trailing TP peak) even when the tick does not close', async () => {
    // pnlPct at tick -2000 is a real, non-zero loss (~-2.93%) per the
    // fixture's known values -- a genuine reading, not a synthetic one, and
    // still inside the TIER 3 -6% stop and the -8% Safety Exit arming
    // threshold, so nothing fires and Trailing TP never arms (never
    // profitable). Was tick -3000 (~-6.4%) before TIER 3 tightened the stop
    // from -15% to -6%, which that tick now breaches.
    const deps = await makeDeps({
      livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) },
      poolPrice: { getPriceState: vi.fn(async () => livePriceState(-2000)) },
    });
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await deps.positions.markActive(created.id, '1', new Date());

    await runExitCycle(deps);

    const reloaded = await deps.positions.findById(created.id);
    expect(reloaded?.status).toBe('ACTIVE'); // not closed -- loss isn't past -6%, and Trailing TP never armed (never profitable)
  });

  it('one position throwing during metrics read does not abort the whole cycle -- other positions still get evaluated', async () => {
    const positions = new InMemoryPositionRepository();
    const exitStates = new InMemoryExitStateRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const bad = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(bad.id, '1', new Date());
    const good = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003' }));
    await positions.markActive(good.id, '2', new Date());

    const livePositionState: LivePositionStateProvider = {
      getLiveState: vi.fn(async (position) => {
        if (position.id === bad.id) throw new Error('RPC timeout');
        return liveState(LIQUIDITY);
      }),
    };

    const results = await runExitCycle({
      positions,
      exitStates,
      txAttempts,
      livePositionState,
      poolPrice: { getPriceState: vi.fn(async () => livePriceState(ENTRY_TICK)) },
      swapExecutor: fakeSwapExecutor,
      tokenGrantPreflight: grantAlreadyValid,
      settings: new InMemorySettingsRepository(),
    });

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.positionId === good.id)?.action).toBe('NONE');
    // bad's metrics read failed but Safety Exit's failure-streak threshold hasn't been crossed yet on the first failure -- still just 'NONE' this tick, not a crash.
    expect(results.find((r) => r.positionId === bad.id)?.action).toBe('NONE');
    const reloadedGood = await positions.findById(good.id);
    const reloadedBad = await positions.findById(bad.id);
    expect(reloadedGood?.status).toBe('ACTIVE');
    expect(reloadedBad?.status).toBe('ACTIVE');
  });

  describe('H4 regression: a shared RPC outage must never cause a synchronized mass Safety-Exit liquidation', () => {
    const FIVE_MIN_AGO = new Date(Date.now() - 6 * 60 * 1000); // past MAX_METRICS_FAILURE_MS (5 min)

    it('Scenario A: RPC has been down 6+ minutes for EVERY active position -- none of them Safety-Exit, no mass liquidation', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const posA = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000010' }));
      await positions.markActive(posA.id, '1', new Date());
      await exitStates.update(posA.id, { metricsFailureSince: FIVE_MIN_AGO });
      const posB = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000011' }));
      await positions.markActive(posB.id, '2', new Date());
      await exitStates.update(posB.id, { metricsFailureSince: FIVE_MIN_AGO });

      const livePositionState: LivePositionStateProvider = { getLiveState: vi.fn(async () => { throw new Error('RPC timeout'); }) };

      const results = await runExitCycle({
        positions,
        exitStates,
        txAttempts,
        livePositionState,
        poolPrice: { getPriceState: vi.fn(async () => { throw new Error('RPC timeout'); }) },
        swapExecutor: fakeSwapExecutor,
        tokenGrantPreflight: grantAlreadyValid,
        settings: new InMemorySettingsRepository(),
      });

      expect(results.every((r) => r.action === 'NONE')).toBe(true);
      expect((await positions.findById(posA.id))?.status).toBe('ACTIVE');
      expect((await positions.findById(posB.id))?.status).toBe('ACTIVE');
      // The failure streak is NOT reset by the suppression -- still counting.
      expect((await exitStates.getOrCreate(posA.id)).metricsFailureSince).not.toBeNull();
    });

    it('Scenario B: only ONE position is failing (genuine, isolated anomaly) while its peer reads fine -- it Safety-Exits normally', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const failing = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000012' }));
      await positions.markActive(failing.id, '1', new Date());
      await exitStates.update(failing.id, { metricsFailureSince: FIVE_MIN_AGO });
      const healthy = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000013' }));
      await positions.markActive(healthy.id, '2', new Date());

      const livePositionState: LivePositionStateProvider = {
        getLiveState: vi.fn(async (position) => {
          // Promise.all([getLiveState, getPriceState]) rejects as soon as
          // EITHER throws -- only failing this one call is enough to make
          // metricsOk false for exactly this position, since both
          // positions otherwise share the same fixture pool/poolId.
          if (position.id === failing.id) throw new Error('this pool genuinely cannot be read');
          return liveState(LIQUIDITY);
        }),
      };
      const poolPrice: PoolPriceProvider = { getPriceState: vi.fn(async () => livePriceState(ENTRY_TICK)) };

      const results = await runExitCycle({
        positions,
        exitStates,
        txAttempts,
        livePositionState,
        poolPrice,
        swapExecutor: fakeSwapExecutor,
        tokenGrantPreflight: grantAlreadyValid,
        settings: new InMemorySettingsRepository(),
      });

      // The isolated anomaly correctly triggers the decision engine to
      // start an INFRA_SAFETY_EXIT close (proving it is NOT suppressed like
      // Scenario A) -- the transaction itself can't actually complete in
      // this test because the same unreadable pool that justified the
      // Safety Exit also makes building the real remove-liquidity tx
      // impossible, which is realistic, not a test artifact.
      expect(results.find((r) => r.positionId === failing.id)?.action).toBe('CLOSE_STARTED');
      expect((await positions.findById(failing.id))?.status).toBe('CLOSING');
      const failingExitState = await exitStates.getOrCreate(failing.id);
      expect(failingExitState.pendingCloseReason).toBe('INFRA_SAFETY_EXIT');
      expect((await positions.findById(healthy.id))?.status).toBe('ACTIVE'); // untouched
    });

    it('Scenario C: CLOSING for INFRA_SAFETY_EXIT, remove-liquidity never even attempted, condition clears -- recovered back to ACTIVE', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000014' }));
      await positions.markActive(created.id, '1', new Date());
      await positions.markClosing(created.id, `exit:${created.id}:1`);
      await exitStates.update(created.id, { pendingCloseReason: 'INFRA_SAFETY_EXIT', metricsFailureSince: FIVE_MIN_AGO });
      // No TransactionAttempt row created for the removeLiquidity leg at all -- nothing was ever attempted.

      const results = await runExitCycle({
        positions,
        exitStates,
        txAttempts,
        livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) }, // metrics read fine NOW -- outage resolved
        poolPrice: { getPriceState: vi.fn(async () => livePriceState(ENTRY_TICK)) },
        swapExecutor: fakeSwapExecutor,
        tokenGrantPreflight: grantAlreadyValid,
        settings: new InMemorySettingsRepository(),
      });

      expect(results.find((r) => r.positionId === created.id)?.action).toBe('NONE');
      const reloaded = await positions.findById(created.id);
      expect(reloaded?.status).toBe('ACTIVE'); // recovered
      expect(reloaded?.closeIdempotencyKey).toBeNull();
      const exitState = await exitStates.getOrCreate(created.id);
      expect(exitState.pendingCloseReason).toBeNull();
      expect(exitState.metricsFailureSince).toBeNull();
    });

    it('Scenario E (P1 audit fix): tryRecoverFromUnstartedSafetyExit is claim-protected -- two concurrent workers racing the SAME recoverable position never both act', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000024' }));
      await positions.markActive(created.id, '1', new Date());
      await positions.markClosing(created.id, `exit:${created.id}:1`);
      await exitStates.update(created.id, { pendingCloseReason: 'INFRA_SAFETY_EXIT', metricsFailureSince: FIVE_MIN_AGO });

      // Wrap claimForResume so the FIRST caller to win the claim is held
      // inside its critical section (via a gate) until the SECOND caller
      // has already been dispatched -- proving the second caller's claim
      // attempt genuinely races against the first's IN-PROGRESS (not yet
      // released) claim, not just "ran strictly before/after" by luck of
      // scheduling. Mirrors the P1-3 executeExit concurrency test's gate
      // pattern exactly.
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let winnerHeldClaim = false;
      const realClaim = positions.claimForResume.bind(positions);
      positions.claimForResume = async (id, status, freshnessMs) => {
        const token = await realClaim(id, status, freshnessMs);
        if (token !== null && !winnerHeldClaim) {
          winnerHeldClaim = true;
          await gate; // the winner pauses here, still holding the claim
        }
        return token;
      };

      const deps = {
        positions,
        exitStates,
        txAttempts,
        livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) },
        poolPrice: { getPriceState: vi.fn(async () => livePriceState(ENTRY_TICK)) },
        swapExecutor: fakeSwapExecutor,
        tokenGrantPreflight: grantAlreadyValid,
        settings: new InMemorySettingsRepository(),
      };

      const call1 = runExitCycle(deps);
      await new Promise((resolve) => setTimeout(resolve, 5)); // let call1 win the claim and enter the gate
      const call2 = runExitCycle(deps);
      await new Promise((resolve) => setTimeout(resolve, 5));
      releaseGate();
      const [results1, results2] = await Promise.all([call1, call2]);

      // Exactly one of the two ticks actually reverted the position -- the
      // other found it already gone from findAllClosing() (recovered) or
      // failed to claim and deferred, never both reverting/racing on it.
      const reloaded = await positions.findById(created.id);
      expect(reloaded?.status).toBe('ACTIVE'); // recovered exactly once, not corrupted by a double-write
      expect(reloaded?.closeIdempotencyKey).toBeNull();

      const allOutcomes = [...results1, ...results2].filter((r) => r.positionId === created.id);
      // At most one NONE (the actual recovery); anything else is either
      // absent (position already gone from findAllClosing by the time
      // that tick's own snapshot ran) or a deferred PENDING -- never a
      // second definitive action on the same position.
      const noneCount = allOutcomes.filter((r) => r.action === 'NONE').length;
      expect(noneCount).toBeLessThanOrEqual(1);
    });

    it('Scenario D: CLOSING for INFRA_SAFETY_EXIT but remove-liquidity is ALREADY VERIFIED -- NEVER reverted to ACTIVE, regardless of current metrics', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000015' }));
      await positions.markActive(created.id, '1', new Date());
      await positions.markClosing(created.id, `exit:${created.id}:1`);
      await exitStates.update(created.id, { pendingCloseReason: 'INFRA_SAFETY_EXIT', metricsFailureSince: FIVE_MIN_AGO });

      const removeKey = `exit:${created.id}:1:removeLiquidity`;
      const removeAttempt = await txAttempts.create(removeKey, 'exit:removeLiquidity');
      await txAttempts.update(removeAttempt.id, { status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: 0n, tokenProceedsRaw: USDG(100) } });

      const results = await runExitCycle({
        positions,
        exitStates,
        txAttempts,
        livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) }, // metrics read fine NOW
        poolPrice: { getPriceState: vi.fn(async () => livePriceState(ENTRY_TICK)) },
        swapExecutor: fakeSwapExecutor,
        tokenGrantPreflight: grantAlreadyValid,
        settings: new InMemorySettingsRepository(),
        readTokenBalance: vi.fn(async () => USDG(100)),
      });

      const reloaded = await positions.findById(created.id);
      expect(reloaded?.status).not.toBe('ACTIVE'); // NEVER reverted -- the LP is genuinely already gone
      expect(results.find((r) => r.positionId === created.id)?.action).toBe('RESUMED'); // proceeded through executeExit normally, not recovered
    });
  });

  describe('H15 regression: DECIDE and RESUME must never both process the same position in the same tick', () => {
    it('a position DECIDE just moved ACTIVE -> CLOSING this tick is NOT re-processed by the RESUME pass in the SAME call -- but a later tick DOES resume it normally', async () => {
      const positions = new InMemoryPositionRepository();
      const exitStates = new InMemoryExitStateRepository();
      const txAttempts = new InMemoryTransactionAttemptRepository();
      const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000020' }));
      await positions.markActive(created.id, '1', new Date());

      let removeLiquidityCalls = 0;
      const buildRemoveLiquidityDeps = () => {
        removeLiquidityCalls++;
        // Ambiguous every call -- stays CLOSING, never reaches VERIFIED,
        // so the position remains eligible for the RESUME pass on a
        // LATER tick (proving H15 only suppresses the SAME-tick case).
        return {
          buildTransaction: vi.fn(async () => ({ to: '0x1111111111111111111111111111111111111111' as const, data: '0xabcdef' as const, value: 0n })),
          simulate: vi.fn(async () => ({ ok: true }) as const),
          estimateGas: vi.fn(async () => 100_000n),
          getGasPrice: vi.fn(async () => 1_000_000_000n),
          checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
          getNonce: vi.fn(async () => 1),
          signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` })),
          broadcastRaw: vi.fn(async () => { throw new Error('ECONNRESET'); }), // ambiguous -- never advances past SIGNED
          waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
          getReceiptIfAvailable: vi.fn(async () => null),
          verifyOnChain: vi.fn(async () => ({ ok: true as const, data: { liquidityZero: true as const, usdgProceedsRaw: 0n, tokenProceedsRaw: USDG(100) } })),
        };
      };

      const tickDeps: RunExitCycleDeps = {
        positions,
        exitStates,
        txAttempts,
        livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) },
        // -3000 -> pnlPct ~ -6.4%, in the un-armed Hard-Stop band (see P0-3) -- fires HARD_STOP_LOSS cleanly, same as before this constant needed adjusting.
        poolPrice: { getPriceState: vi.fn(async () => livePriceState(-3000)) }, // triggers HARD_STOP_LOSS immediately
        swapExecutor: fakeSwapExecutor,
        tokenGrantPreflight: grantAlreadyValid,
        settings: new InMemorySettingsRepository(),
        buildRemoveLiquidityDeps,
      };

      // Tick 1: DECIDE moves ACTIVE -> CLOSING and calls executeExit ONCE.
      // If H15's fix were absent, the RESUME pass in this SAME call would
      // find the position via findAllClosing() and call executeExit a
      // SECOND time, doubling this count within one tick.
      const tick1 = await runExitCycle(tickDeps);
      expect(removeLiquidityCalls).toBe(1);
      expect(tick1.filter((r) => r.positionId === created.id)).toHaveLength(1);
      expect(tick1.find((r) => r.positionId === created.id)?.action).toBe('CLOSE_STARTED');
      expect((await positions.findById(created.id))?.status).toBe('CLOSING');

      // Tick 2 (a genuinely later call -- a fresh handledThisTick set):
      // the RESUME pass legitimately picks the SAME still-CLOSING position
      // back up and retries the ambiguous remove-liquidity leg again.
      const tick2 = await runExitCycle(tickDeps);
      expect(removeLiquidityCalls).toBe(2);
      expect(tick2.find((r) => r.positionId === created.id)?.action).toBe('RESUMED');
    });
  });

  describe('resumption pass: positions already CLOSING get executeExit called again', () => {
    it('resumes a CLOSING position independently of the ACTIVE-position decide pass', async () => {
      const deps = await makeDeps();
      const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
      await deps.positions.markActive(created.id, '1', new Date());
      await deps.positions.markClosing(created.id, `exit:${created.id}:attempt-1`);
      await deps.exitStates.update(created.id, { pendingCloseReason: 'HARD_STOP_LOSS' });

      const results = await runExitCycle(deps);

      expect(results).toHaveLength(1);
      expect(results[0]?.action).toBe('RESUMED');
      expect(results[0]?.outcome).toEqual({ outcome: 'CLOSED' });
      const reloaded = await deps.positions.findById(created.id);
      expect(reloaded?.status).toBe('CLOSED');
    });
  });

  describe('Module 10 -- live hardStopLossPct, read fresh each cycle', () => {
    it('a PNL of ~-4.5% is NOT closed under the frozen -6% TIER 3 default, but IS closed once hardStopLossPct is live-tightened to -4%', async () => {
      // tick -2500 against this fixture's entry deterministically computes
      // pnlPct ~= -0.0452 (verified via computePositionMetrics directly) --
      // between -4% and -6%, still in range (so OOR can never interfere)
      // and well inside the -8% Safety Exit arming threshold. The shape of
      // the proof is unchanged; only the two thresholds moved with the
      // TIER 3 stop (-15% -> -6%).
      const deps = await makeDeps({
        livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) },
        poolPrice: { getPriceState: vi.fn(async () => livePriceState(-2500)) },
      });
      const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
      await deps.positions.markActive(created.id, '1', new Date());

      const underFrozenDefault = await runExitCycle(deps);
      expect(underFrozenDefault[0]?.action).toBe('NONE');
      expect((await deps.positions.findById(created.id))?.status).toBe('ACTIVE');

      await deps.settings.update({ hardStopLossPct: -0.04 }); // tightened live -- TIER 3 removed the old cross-field floor, so any in-bounds value is settable
      const underLiveSetting = await runExitCycle(deps);

      expect(underLiveSetting[0]?.action).toBe('CLOSE_STARTED');
      expect(underLiveSetting[0]?.outcome).toEqual({ outcome: 'CLOSED' });
      const reloaded = await deps.positions.findById(created.id);
      expect(reloaded?.status).toBe('CLOSED');
      expect(reloaded?.closeReason).toBe('HARD_STOP_LOSS');
    });
  });

  describe('LOW_YIELD validation-phase resolution -- the shipped default is DISABLED, and the wiring never fires it on its own', () => {
    /**
     * Meridian's metric is pool-level 24h fees/TVL; Lunex cannot reproduce
     * it (no pool-level fee or TVL data source exists -- see
     * EXITS.LOW_YIELD's doc comment), so the rule ships disabled. These
     * tests pin that end to end at the ORCHESTRATOR level, not just the
     * pure-decision level: the exact position that WOULD have closed for
     * LOW_YIELD under the pre-validation default (old, in range, in
     * moderate loss, zero fees earned) must stay ACTIVE under the frozen
     * shipped config -- no substitute metric, no fabricated yield, no
     * silent policy change -- while the underlying rule logic is proven
     * intact via an explicitly-enabled rules override.
     */
    const OLD = new Date(Date.now() - 60 * 60 * 1000); // 60 minutes -- past the 30-min age floor

    function lowYieldDeps() {
      return makeDeps({
        livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) },
        // ENTRY_TICK: in range (so OOR can never interfere), and ~-2.93%
        // PnL -- a real loss that fires nothing above LOW_YIELD's priority.
        poolPrice: { getPriceState: vi.fn(async () => livePriceState(-2000)) },
      });
    }

    it('a 60-minute-old, zero-fee, in-range, ~-2.9% position stays ACTIVE under the SHIPPED config', async () => {
      const deps = await lowYieldDeps();
      const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
      await deps.positions.markActive(created.id, '1', OLD);

      const results = await runExitCycle(deps);

      expect(results).toEqual([{ positionId: created.id, action: 'NONE' }]);
      expect((await deps.positions.findById(created.id))?.status).toBe('ACTIVE');
    });

    it('the same position DOES close for LOW_YIELD when the rule is enabled -- the rule logic is intact, only the default flipped', async () => {
      // 60 minutes old + zero fees (liveState's tokensOwed are 0n) + a
      // genuine ~-2.9% reading: every LOW_YIELD precondition holds, so
      // enabling the rule must produce a LOW_YIELD close on the next tick.
      // This proves the disabled default is a policy choice, not a broken
      // rule that silently fails for another reason.
      const deps = await lowYieldDeps();
      const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
      await deps.positions.markActive(created.id, '1', OLD);

      const results = await runExitCycle({
        ...deps,
        exitRulesOverride: {
          ...config.rules.exits,
          LOW_YIELD: { ...config.rules.exits.LOW_YIELD, ENABLED: true },
        },
      });

      expect(results[0]?.action).toBe('CLOSE_STARTED');
      const reloaded = await deps.positions.findById(created.id);
      expect(reloaded?.status).toBe('CLOSED');
      expect(reloaded?.closeReason).toBe('LOW_YIELD');
    });
  });
});

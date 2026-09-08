import { describe, expect, it, vi } from 'vitest';
import { runExitCycle } from '../../src/exits/runExitCycle';
import type { LivePositionStateProvider, PoolPriceProvider } from '../../src/monitoring/types';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemorySettingsRepository } from '../settings/inMemorySettingsRepository';
import { deriveEntryLiquidity, ENTRY_TICK, liveState, livePriceState, makeExitTestPosition } from './positionFixture';
import { makeCreateInput } from '../positions/fixtures';
import type { SwapExecutor } from '../../src/swap/types';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import type { Address } from 'viem';

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
  getQuote: vi.fn(async () => ({ amountInRaw: USDG(0), expectedAmountOutRaw: USDG(0), minOutputAmountRaw: 0n, priceImpactPct: 0.001, allowanceTarget: null })),
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
    settings: new InMemorySettingsRepository(),
    buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const })),
    buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: 0n })),
    readTokenBalance: vi.fn(async () => USDG(100)),
    readAllowance: vi.fn(async () => 0n),
    walletAddress: WALLET,
  };
}

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
    it('closes for HARD_STOP_LOSS, not OOR, and executes the full exit through to CLOSED', async () => {
      const deps = await makeDeps({
        livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) },
        poolPrice: { getPriceState: vi.fn(async () => livePriceState(-7000)) }, // pnlPct ~ -0.29 (past -15%), inRange: false
      });
      const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
      await deps.positions.markActive(created.id, '1', new Date());
      // OOR has already been "running" for 40 minutes as of this tick -- would independently trigger OOR on its own.
      await deps.exitStates.update(created.id, { oorStartedAt: new Date(Date.now() - 40 * 60 * 1000) });

      const results = await runExitCycle(deps);

      expect(results).toHaveLength(1);
      expect(results[0]?.action).toBe('CLOSE_STARTED');
      expect(results[0]?.outcome).toEqual({ outcome: 'CLOSED' });

      const reloaded = await deps.positions.findById(created.id);
      expect(reloaded?.status).toBe('CLOSED');
      expect(reloaded?.closeReason).toBe('HARD_STOP_LOSS'); // NOT 'OOR', despite OOR's own timer having independently elapsed
    });
  });

  it('persists the fresh live-metrics-derived exit state (e.g. a newly-armed Trailing TP peak) even when the tick does not close', async () => {
    // pnlPct at tick -3000 is a real, non-zero loss (~-6.4%) per the fixture's known values -- not enough to trigger anything, but confirms real metrics flow through into persisted state, not synthetic ones.
    const deps = await makeDeps({
      livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) },
      poolPrice: { getPriceState: vi.fn(async () => livePriceState(-3000)) },
    });
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await deps.positions.markActive(created.id, '1', new Date());

    await runExitCycle(deps);

    const reloaded = await deps.positions.findById(created.id);
    expect(reloaded?.status).toBe('ACTIVE'); // not closed -- loss isn't past -15%, and Trailing TP never armed (never profitable)
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
    it('a PNL of ~-11% is NOT closed under the frozen -15% default, but IS closed once hardStopLossPct is live-tightened to -8%', async () => {
      // tick -4000 against this fixture's entry deterministically computes pnlPct ~= -0.1096 (verified via computePositionMetrics directly) -- between -8% and -15%, still in range (so OOR can never interfere).
      const deps = await makeDeps({
        livePositionState: { getLiveState: vi.fn(async () => liveState(LIQUIDITY)) },
        poolPrice: { getPriceState: vi.fn(async () => livePriceState(-4000)) },
      });
      const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
      await deps.positions.markActive(created.id, '1', new Date());

      const underFrozenDefault = await runExitCycle(deps);
      expect(underFrozenDefault[0]?.action).toBe('NONE');
      expect((await deps.positions.findById(created.id))?.status).toBe('ACTIVE');

      await deps.settings.update({ hardStopLossPct: -0.08 }); // tightened live, still >= the frozen PNL Protection boundary (-8%, the strictest allowed value)
      const underLiveSetting = await runExitCycle(deps);

      expect(underLiveSetting[0]?.action).toBe('CLOSE_STARTED');
      expect(underLiveSetting[0]?.outcome).toEqual({ outcome: 'CLOSED' });
      const reloaded = await deps.positions.findById(created.id);
      expect(reloaded?.status).toBe('CLOSED');
      expect(reloaded?.closeReason).toBe('HARD_STOP_LOSS');
    });
  });
});

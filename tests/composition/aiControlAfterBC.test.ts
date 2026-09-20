import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { runScreeningCycle } from '../../src/composition/screeningCycle';
import { runExitAndOpenResumeCycle } from '../../src/composition/exitCycle';
import { runMonitoringLoggingCycle } from '../../src/composition/monitoringCycle';
import { openPosition } from '../../src/positions/openPosition';
import { settleResidualDust, DUST_CONFIRMATION } from '../../src/exits/dustSettlement';
import { createFakeAppDeps, fakeTxDeps, makeCandidate } from './fakeAppDeps';
import { validPermit2 } from '../positions/permit2Fixtures';
import { makeCreateInput } from '../positions/fixtures';
import type { CapitalRules } from '../../src/capital/types';
import type { AppDeps } from '../../src/composition/types';
import type { createInMemoryLogger } from '../../src/composition/logger';

/**
 * AI entry control re-audited against the code as it stands AFTER commits B
 * (two-layer execution-target validation + deterministic backoff) and C
 * (operator dust settlement).
 *
 * The original AI tests predate both, so these cover the new seams: the Permit2
 * pre-flight that now runs BEFORE the capital reservation, the dust settlement
 * an operator can perform while the AI has entry paused, and the capital
 * accounting neither of them may disturb.
 */

const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const U = (n: number): bigint => BigInt(n) * 10n ** 18n;
const RULES: CapitalRules = { MAX_ACTIVE_POSITIONS: 3, POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35, MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.95, ETH_GAS_RESERVE_ENABLED: false, ETH_GAS_RESERVE_MIN: 0 };
const lines = (deps: AppDeps) => (deps.logger as ReturnType<typeof createInMemoryLogger>).lines;

describe('AI entry control x commit B (Permit2 pre-flight)', () => {
  it('the reservation gate still refuses while AI-paused even when the Permit2 pre-flight passes -- nothing is reserved', async () => {
    const deps = createFakeAppDeps();
    await deps.settings.aiPauseEntry('rid-b1');
    const permit2Preflight = vi.fn(async () => validPermit2());

    const outcome = await openPosition(
      {
        tokenAddress: TOKEN, tokenSymbol: 'MEME', tokenDecimals: 18, pool: (await import('../positions/fixtures')).POOL,
        tickLower: -6960, tickUpper: -60, entryUsdgRaw: U(350), entryTick: 0, entrySqrtPriceX96: 2n ** 96n,
        readOnChainUsdgBalance: async () => U(1000), capitalRules: RULES,
      },
      {
        positions: deps.positions, txAttempts: deps.txAttempts, livePositionState: deps.livePositionState, poolPrice: deps.poolPrice,
        permit2Preflight, readAllowance: vi.fn(async () => U(1000)), walletAddress: deps.walletAddress,
        buildApproveDeps: vi.fn(() => fakeTxDeps({ allowanceRaw: U(350) })),
        buildMintDeps: vi.fn(() => fakeTxDeps({ positionTokenId: '9', liquidity: 1n })),
      },
    );

    expect(outcome).toMatchObject({ outcome: 'FAILED', entryPausedBy: 'AI' });
    expect(permit2Preflight).toHaveBeenCalledTimes(1); // pre-flight runs first; the gate is what refuses
    expect(await deps.positions.findAllOpening()).toHaveLength(0);
    expect(await deps.positions.findAllActive()).toHaveLength(0);
    expect(await deps.txAttempts.findNonTerminal()).toHaveLength(0);
  });

  it('a Permit2 block and an AI pause are reported distinctly (neither is mistaken for the other)', async () => {
    const blocked = validPermit2({ status: 'EXPIRED', deployable: false, reason: 'test: expired' });
    const permit2Deps = createFakeAppDeps({
      discoveryService: { discoverTopCandidates: vi.fn(async () => [makeCandidate()]) } as never,
      permit2Preflight: vi.fn(async () => blocked),
    });
    const s1 = await runScreeningCycle(permit2Deps);
    expect(s1.skipped[0]).toMatchObject({ stage: 'permit2' });
    expect(lines(permit2Deps).some((l) => l.event === 'AI_ENTRY_BLOCKED_BY_PAUSE')).toBe(false);

    const aiDeps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [makeCandidate()]) } as never });
    await aiDeps.settings.aiPauseEntry('rid-b2');
    const s2 = await runScreeningCycle(aiDeps);
    expect(s2.paused).toBe(true);
    expect(lines(aiDeps).find((l) => l.event === 'AI_ENTRY_BLOCKED_BY_PAUSE')?.data).toMatchObject({ stage: 'cycle-start' });
    expect(lines(aiDeps).some((l) => l.event === 'entry_blocked_permit2')).toBe(false);
  });
});

describe('AI entry control x commit C (operator dust settlement)', () => {
  it('an operator can still dust-settle a CLOSING position while the AI has entry paused', async () => {
    const deps = createFakeAppDeps();
    await deps.settings.aiPauseEntry('rid-c1');

    const created = await deps.positions.create(makeCreateInput({ entryUsdgRaw: 20_906_915n, tokenAddress: TOKEN }));
    await deps.positions.markActive(created.id, '1', new Date());
    await deps.positions.markClosing(created.id, `exit:${created.id}:k`);
    const position = (await deps.positions.findById(created.id))!;
    const remove = await deps.txAttempts.create(`${position.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
    await deps.txAttempts.update(remove.id, { status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: '20915201', tokenProceedsRaw: '14467194911816926' } });

    const result = await settleResidualDust(
      {
        positions: deps.positions, txAttempts: deps.txAttempts,
        swapExecutor: { getQuote: vi.fn(async (_t: Address, amountInRaw: bigint) => ({ amountInRaw, expectedAmountOutRaw: 8464n, minOutputAmountRaw: 0n, priceImpactPct: 0.001, slippageBps: 100, providerQuote: {} })), checkApproval: vi.fn(), buildSwapTx: vi.fn() } as never,
        readTokenBalance: vi.fn(async () => 10n ** 30n), walletAddress: deps.walletAddress,
      },
      { positionId: position.id, closeIdempotencyKey: position.closeIdempotencyKey!, confirm: DUST_CONFIRMATION, actor: 'admin', requestId: 'r1' },
    );

    expect(result.outcome).toBe('SETTLED');
    expect((await deps.positions.findById(position.id))?.closeReason).toBe('DUST_SETTLEMENT');
    // the AI pause is untouched by an operator action
    expect((await deps.settings.getEntryState()).aiEntryPaused).toBe(true);
  });

  it('AI pause/resume never alters positions, capital accounting or realized proceeds', async () => {
    const deps = createFakeAppDeps();
    const created = await deps.positions.create(makeCreateInput({ entryUsdgRaw: U(350), tokenAddress: TOKEN }));
    await deps.positions.markActive(created.id, '1', new Date());
    const before = await deps.positions.findById(created.id);
    const capitalBefore = await deps.capitalSnapshot.getSnapshot();

    await deps.settings.aiPauseEntry('rid-c2');
    await deps.settings.aiResumeEntry('rid-c3');
    await deps.settings.aiPauseEntry('rid-c4');

    expect(await deps.positions.findById(created.id)).toEqual(before);
    const capitalAfter = await deps.capitalSnapshot.getSnapshot();
    expect(capitalAfter.totalDeployedUsdg).toBe(capitalBefore.totalDeployedUsdg);
    expect(capitalAfter.freeUsdgBalance).toBe(capitalBefore.freeUsdgBalance);
  });
});

describe('AI entry control x operator pause (both flags)', () => {
  it('an AI resume while the operator pause stands leaves entry blocked through a whole screening cycle', async () => {
    const discoverTopCandidates = vi.fn(async () => [makeCandidate()]);
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates } as never });
    await deps.settings.pause();
    await deps.settings.aiPauseEntry('rid-o1');

    await deps.settings.aiResumeEntry('rid-o2'); // AI gives up its own pause...

    const state = await deps.settings.getEntryState();
    expect(state).toMatchObject({ operatorPaused: true, aiEntryPaused: false, entryPaused: true });
    const summary = await runScreeningCycle(deps);
    expect(summary.paused).toBe(true);
    expect(summary.deployed).toBe(0);
    expect(discoverTopCandidates).not.toHaveBeenCalled();
    expect((await deps.settings.get()).paused).toBe(true); // operator flag untouched by the AI
  });

  it('an operator resume while the AI pause stands also leaves entry blocked', async () => {
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [makeCandidate()]) } as never });
    await deps.settings.pause();
    await deps.settings.aiPauseEntry('rid-o3');

    await deps.settings.resume(); // operator lifts theirs...

    expect(await deps.settings.getEntryState()).toMatchObject({ operatorPaused: false, aiEntryPaused: true, entryPaused: true });
    expect((await runScreeningCycle(deps)).deployed).toBe(0);
  });

  it('only when BOTH are clear does entry proceed', async () => {
    const deps = createFakeAppDeps({ discoveryService: { discoverTopCandidates: vi.fn(async () => [makeCandidate()]) } as never });
    await deps.settings.pause();
    await deps.settings.aiPauseEntry('rid-o4');
    await deps.settings.resume();
    await deps.settings.aiResumeEntry('rid-o5');

    expect(await deps.settings.getEntryState()).toMatchObject({ operatorPaused: false, aiEntryPaused: false, entryPaused: false });
    expect((await runScreeningCycle(deps)).deployed).toBe(1);
  });

  it('monitoring and the exit cycle keep running under an AI pause (never gated by entry state)', async () => {
    const deps = createFakeAppDeps();
    await deps.settings.aiPauseEntry('rid-o6');
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: TOKEN }));
    await deps.positions.markActive(created.id, '1', new Date());

    expect((await runMonitoringLoggingCycle(deps)).map((m) => m.positionId)).toEqual([created.id]);
    await expect(runExitAndOpenResumeCycle(deps)).resolves.toBeDefined();
    expect((await deps.positions.findById(created.id))?.status).toBe('ACTIVE');
  });
});

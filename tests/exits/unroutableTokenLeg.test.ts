import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import request from 'supertest';
import { executeExit } from '../../src/exits/executeExit';
import type { ExecuteExitDeps } from '../../src/exits/executeExit';
import { assessClosingRecovery } from '../../src/exits/closingRecovery';
import { exitLegKeyPrefix } from '../../src/capital/freshCapitalSnapshot';
import { PositionCapitalSnapshotProvider } from '../../src/positions/capitalSnapshotProvider';
import { DuplicateActiveTokenPositionError } from '../../src/positions/types';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';
import { EMPTY_EXIT_STATE } from '../../src/exits/types';
import { config } from '../../src/config';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { makeCreateInput } from '../positions/fixtures';
import { buildTestApp, authHeader } from '../api/testApp';

// Unroutable TOKEN leg: a CLOSING position whose remove-liquidity receipt
// proved TOKEN > 0, but whose TOKEN->USDG swap cannot currently be quoted or
// clears the price-impact gate. It must stay CLOSING (TOKEN retained, slot +
// token lock + capital kept, no cooldown, no fake proceeds), be recorded
// durably, and become operator-visible under the EXISTING stuck policy --
// never auto-closed, never valued at zero.

const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;
const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };
const STUCK_AGE = config.rules.execution.STUCK_ATTEMPT_MAX_AGE_MS;
const RESIDUAL = USDG(3); // TOKEN paid by the remove receipt

function fakeTxDeps<T>(data: T, overrides: Partial<TxSafetyDeps<T>> = {}): TxSafetyDeps<T> {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 7),
    signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data })),
    ...overrides,
  };
}

const QUOTE: SwapQuote = { amountInRaw: RESIDUAL, expectedAmountOutRaw: USDG(290), minOutputAmountRaw: 0n, priceImpactPct: 0.001, slippageBps: 100, providerQuote: {} };
const noQuote = (): SwapExecutor => ({ getQuote: vi.fn(async () => { throw new Error('HTTP 404 No quotes available'); }), checkApproval: vi.fn(), buildSwapTx: vi.fn() });
const impactBlocked = (): SwapExecutor => ({ getQuote: vi.fn(async () => ({ ...QUOTE, priceImpactPct: null })), checkApproval: vi.fn(), buildSwapTx: vi.fn() });
const routable = (): SwapExecutor => ({ getQuote: vi.fn(async () => QUOTE), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn(async () => TX) });

async function setup() {
  const cooldown = { recordExit: vi.fn(async (_t: string, _at?: Date) => undefined) };
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const positions = new InMemoryPositionRepository(txAttempts, cooldown);
  const exitStates = new InMemoryExitStateRepository();
  const created = await positions.create(makeCreateInput({ tokenAddress: TOKEN, entryUsdgRaw: USDG(500) }));
  await positions.markActive(created.id, '1', new Date());
  const position = (await positions.markClosing(created.id, `exit:${created.id}:1`))!;
  exitStates.seed({ positionId: created.id, ...EMPTY_EXIT_STATE, pendingCloseReason: 'HARD_STOP_LOSS' });
  const removeDeps = fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: USDG(200), tokenProceedsRaw: RESIDUAL });
  const swapDeps = fakeTxDeps({ usdgIncreaseRaw: USDG(290), usdgProceedsRaw: USDG(290) });
  const deps = (swapExecutor: SwapExecutor, o: Partial<ExecuteExitDeps> = {}): ExecuteExitDeps => ({
    positions,
    exitStates,
    txAttempts,
    livePositionState: { getLiveState: vi.fn() },
    poolPrice: { getPriceState: vi.fn() },
    swapExecutor,
    buildRemoveLiquidityDeps: vi.fn(() => removeDeps),
    buildSwapDeps: vi.fn(() => swapDeps),
    readTokenBalance: vi.fn(async () => RESIDUAL),
    readAllowance: vi.fn(async () => 0n),
    walletAddress: WALLET,
    warnLog: vi.fn(),
    ...o,
  });
  const assess = async (now = new Date()) =>
    assessClosingRecovery((await positions.findById(created.id))!, await txAttempts.findByKeyPrefixes([exitLegKeyPrefix(position.closeIdempotencyKey!)]), await exitStates.getOrCreate(created.id), now);
  return { cooldown, positions, exitStates, txAttempts, position, removeDeps, swapDeps, deps, assess };
}

async function expectStillStuckAndIntact(ctx: Awaited<ReturnType<typeof setup>>) {
  const row = await ctx.positions.findById(ctx.position.id);
  expect(row).toMatchObject({ status: 'CLOSING', realizedUsdgRaw: null, closedAt: null }); // no fake close, no fake proceeds
  expect(ctx.cooldown.recordExit).not.toHaveBeenCalled(); // no cooldown while TOKEN is unresolved
  expect(ctx.swapDeps.broadcastRaw).not.toHaveBeenCalled(); // no swap tx, no gas
  expect(await ctx.txAttempts.find(`${ctx.position.closeIdempotencyKey}:swap:0`)).toBeNull();
  expect((await ctx.exitStates.getOrCreate(ctx.position.id)).swapAttemptCount).toBe(0); // no counter inflation without a real attempt
}

describe('Unroutable TOKEN leg -- stays CLOSING, recorded durably, operator-visible, never faked', () => {
  it('(A) quote unavailable: TOKEN retained, CLOSING, no swap tx, no gas, no CLOSED, no cooldown; the block is recorded with its reason', async () => {
    const ctx = await setup();
    expect((await executeExit(ctx.position, ctx.deps(noQuote()))).outcome).toBe('PENDING');
    await expectStillStuckAndIntact(ctx);
    const state = await ctx.exitStates.getOrCreate(ctx.position.id);
    expect(state.swapLegBlockedReason).toBe('QUOTE_UNAVAILABLE');
    expect(state.swapLegBlockedSince).toBeInstanceOf(Date);
  });

  it('(B) price-impact blocked: identical guarantees, reason PRICE_IMPACT_BLOCKED', async () => {
    const ctx = await setup();
    expect((await executeExit(ctx.position, ctx.deps(impactBlocked()))).outcome).toBe('PENDING');
    await expectStillStuckAndIntact(ctx);
    expect((await ctx.exitStates.getOrCreate(ctx.position.id)).swapLegBlockedReason).toBe('PRICE_IMPACT_BLOCKED');
  });

  it('(C) repeated retries: no state corruption, blockedSince never moves (also across a reason flip), no counter inflation, logged ONCE per block (not every tick) -- and NO automatic fake close however long it lasts', async () => {
    const ctx = await setup();
    const warnLog = vi.fn();
    await executeExit(ctx.position, ctx.deps(noQuote(), { warnLog }));
    const since = (await ctx.exitStates.getOrCreate(ctx.position.id)).swapLegBlockedSince;
    for (let i = 0; i < 5; i++) expect((await executeExit(ctx.position, ctx.deps(noQuote(), { warnLog }))).outcome).toBe('PENDING');
    expect(warnLog.mock.calls.filter(([e]) => e === 'exit_token_leg_unactionable')).toHaveLength(1);
    await executeExit(ctx.position, ctx.deps(impactBlocked(), { warnLog })); // reason changes -> logged once more
    expect(warnLog.mock.calls.filter(([e]) => e === 'exit_token_leg_unactionable')).toHaveLength(2);
    const state = await ctx.exitStates.getOrCreate(ctx.position.id);
    expect(state.swapLegBlockedSince).toEqual(since); // one continuous block
    await expectStillStuckAndIntact(ctx);
    // Classified for the operator, never closed: far past the stuck age, still CLOSING.
    expect((await ctx.assess(new Date(since!.getTime() + 100 * STUCK_AGE))).operatorActionRequired).toBe(true);
    await expectStillStuckAndIntact(ctx);
  });

  it('(F) operator view: before the existing stuck age -> visible but no action flagged; at/after it -> OPERATOR_ACTION_REQUIRED, with receipt-proven TOKEN residual, USDG already recovered, age and last check', async () => {
    const ctx = await setup();
    await executeExit(ctx.position, ctx.deps(noQuote()));
    const since = (await ctx.exitStates.getOrCreate(ctx.position.id)).swapLegBlockedSince!;
    const early = await ctx.assess(new Date(since.getTime() + STUCK_AGE - 1));
    expect(early).toMatchObject({ phase: 'QUOTE_UNAVAILABLE', operatorActionRequired: false, tokenResidualRaw: RESIDUAL, usdgRecoveredRaw: USDG(200), closeReason: 'HARD_STOP_LOSS' });
    const late = await ctx.assess(new Date(since.getTime() + STUCK_AGE));
    expect(late.operatorActionRequired).toBe(true);
    expect(late.lastCheckedAt).toBeInstanceOf(Date);
    expect(late.closingAgeMs).not.toBeNull();
  });

  it('(D, K) successful recovery later: quote becomes available -> exactly one swap, verified, close finalizes, cooldown exactly once, block cleared, realized = actual USDG only', async () => {
    const ctx = await setup();
    await executeExit(ctx.position, ctx.deps(noQuote()));
    expect((await ctx.positions.findById(ctx.position.id))?.realizedUsdgRaw).toBeNull(); // (K) nothing realized while TOKEN unresolved
    expect(await executeExit(ctx.position, ctx.deps(routable()))).toEqual({ outcome: 'CLOSED' });
    expect(ctx.swapDeps.broadcastRaw).toHaveBeenCalledTimes(1);
    expect(ctx.removeDeps.broadcastRaw).toHaveBeenCalledTimes(1); // remove never repeated
    expect(ctx.cooldown.recordExit).toHaveBeenCalledTimes(1);
    const closed = await ctx.positions.findById(ctx.position.id);
    expect(closed?.realizedUsdgRaw).toBe(USDG(200) + USDG(290)); // remove + swap receipts, nothing invented
    expect((await ctx.exitStates.getOrCreate(ctx.position.id)).swapLegBlockedReason ?? null).toBeNull();
  });

  it('(H, stale) a worker still on an OLDER swap attempt cannot record or clear a block for the current one', async () => {
    const ctx = await setup();
    await executeExit(ctx.position, ctx.deps(noQuote()));
    expect(await ctx.exitStates.incrementSwapAttemptFrom(ctx.position.id, 0)).toBe(true); // attempt 0 failed; now attempt 1
    expect(await ctx.exitStates.recordSwapLegBlocked(ctx.position.id, 0, 'PRICE_IMPACT_BLOCKED', new Date())).toBe('STALE');
    await ctx.exitStates.clearSwapLegBlocked(ctx.position.id, 0);
    expect((await ctx.exitStates.getOrCreate(ctx.position.id)).swapLegBlockedReason).toBe('QUOTE_UNAVAILABLE'); // untouched by the stale worker
  });

  it('(H) two concurrent exit workers on the blocked position: one runs (claim), neither swaps, state stays consistent', async () => {
    const ctx = await setup();
    await executeExit(ctx.position, ctx.deps(noQuote()));
    const outcomes = await Promise.all([executeExit(ctx.position, ctx.deps(noQuote())), executeExit(ctx.position, ctx.deps(noQuote()))]);
    expect(outcomes.every((o) => o.outcome === 'PENDING')).toBe(true);
    await expectStillStuckAndIntact(ctx);
  });

  it('(I) H2 capital accounting while stuck: returned USDG counted once (wallet), the unswapped TOKEN carried at its unrecovered cost basis -- the base stays the TRUE portfolio', async () => {
    const ctx = await setup();
    await executeExit(ctx.position, ctx.deps(noQuote()));
    // Portfolio 1000: 500 outside, 500 entry -> burn returned 200 USDG + TOKEN (cost basis 300 unrecovered).
    const snapshot = await new PositionCapitalSnapshotProvider(ctx.positions, WALLET, async () => USDG(700), ctx.txAttempts).getSnapshot();
    expect(snapshot).toEqual({ freeUsdgBalance: USDG(700), totalDeployedUsdg: USDG(300), activePositionsCount: 1 });
    expect(snapshot.freeUsdgBalance + snapshot.totalDeployedUsdg).toBe(USDG(1000));
  });

  it('(J) slot + token lock kept while stuck: the same token cannot be re-entered, and the CLOSING position still counts toward the position cap', async () => {
    const ctx = await setup();
    await executeExit(ctx.position, ctx.deps(noQuote()));
    await expect(ctx.positions.create(makeCreateInput({ tokenAddress: TOKEN, openIdempotencyKey: 'deploy:reentry' }))).rejects.toBeInstanceOf(DuplicateActiveTokenPositionError);
    expect(await ctx.positions.countNonClosed()).toBe(1);
  });

  it('(L) H1 unchanged: TOKEN=0 receipt -> USDG-only close (never classified as a TOKEN leg); a below-floor USDG-only receipt is flagged USDG_ONLY_ANOMALY for the operator', async () => {
    const ctx = await setup();
    ctx.removeDeps.verifyOnChain = vi.fn(async () => ({ ok: true as const, data: { liquidityZero: true as const, usdgProceedsRaw: USDG(500), tokenProceedsRaw: 0n } }));
    expect(await executeExit(ctx.position, ctx.deps(noQuote()))).toEqual({ outcome: 'CLOSED' });

    const anomaly = await setup();
    anomaly.removeDeps.verifyOnChain = vi.fn(async () => ({ ok: true as const, data: { liquidityZero: true as const, usdgProceedsRaw: USDG(10), tokenProceedsRaw: 0n } }));
    expect((await executeExit(anomaly.position, anomaly.deps(noQuote()))).outcome).toBe('PENDING');
    expect(await anomaly.assess()).toMatchObject({ phase: 'USDG_ONLY_ANOMALY', operatorActionRequired: true });
  });

  it('(M) ambiguous remove (broadcast uncertain) -> AMBIGUOUS, flagged only once the existing isStuckAttempt policy says so', async () => {
    const ctx = await setup();
    ctx.removeDeps.broadcastRaw = vi.fn(async () => { throw new Error('ECONNRESET'); });
    expect((await executeExit(ctx.position, ctx.deps(noQuote()))).outcome).toBe('PENDING');
    const r = await ctx.assess();
    expect(r.phase).toBe('AMBIGUOUS');
    expect(r.operatorActionRequired).toBe(false);
    expect((await ctx.assess(new Date(Date.now() + STUCK_AGE + 1000))).operatorActionRequired).toBe(true);
  });

  it('(N) failed swaps: counts below the existing STUCK_THRESHOLD retry quietly; at the threshold the operator is flagged', async () => {
    const ctx = await setup();
    await ctx.exitStates.getOrCreate(ctx.position.id);
    await executeExit(ctx.position, ctx.deps(routable(), { buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: 0n, usdgProceedsRaw: 0n }, { simulate: vi.fn(async () => ({ ok: false as const, reason: 'revert' })) })) }));
    expect(await ctx.assess()).toMatchObject({ phase: 'SWAP_FAILED_RETRY_PENDING', operatorActionRequired: false, swapAttemptCount: 1 });
    await ctx.exitStates.incrementSwapAttemptFrom(ctx.position.id, 1);
    await ctx.exitStates.incrementSwapAttemptFrom(ctx.position.id, 2);
    expect(await ctx.assess()).toMatchObject({ phase: 'SWAP_FAILED_RETRY_PENDING', operatorActionRequired: true });
    expect(ctx.cooldown.recordExit).not.toHaveBeenCalled();
  });

  it('(O) legacy remove attempt without a recorded TOKEN amount: residual reported as UNKNOWN (null), never guessed as 0', async () => {
    const ctx = await setup();
    ctx.removeDeps.verifyOnChain = vi.fn(async () => ({ ok: true as const, data: { liquidityZero: true as const, usdgProceedsRaw: USDG(200) } as never }));
    await executeExit(ctx.position, ctx.deps(noQuote())); // legacy path: live balance 3 TOKEN -> swap path -> no quote
    const r = await ctx.assess();
    expect(r.phase).toBe('QUOTE_UNAVAILABLE');
    expect(r.tokenResidualRaw).toBeNull();
  });
});

describe('Unroutable TOKEN leg -- operator surface (existing authenticated API)', () => {
  it('(F) GET /positions/stuck lists the blocked CLOSING position with phase, TOKEN residual, USDG recovered, age, last check and the operator flag', async () => {
    const { app, deps } = buildTestApp();
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000009', entryUsdgRaw: USDG(500) }));
    await deps.positions.markActive(created.id, '1', new Date());
    const closing = (await deps.positions.markClosing(created.id, `exit:${created.id}:1`))!;
    const remove = await deps.txAttempts.create(`${closing.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
    const longAgo = new Date(Date.now() - 2 * STUCK_AGE);
    await deps.txAttempts.update(remove.id, { status: 'VERIFIED', firstAttemptedAt: longAgo, verifyData: { liquidityZero: true, usdgProceedsRaw: USDG(200), tokenProceedsRaw: RESIDUAL } });
    await deps.exitStates.getOrCreate(created.id);
    await deps.exitStates.recordSwapLegBlocked(created.id, 0, 'QUOTE_UNAVAILABLE', longAgo);

    const res = await request(app).get('/positions/stuck').set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.operatorActionRequiredPositionIds).toEqual([created.id]);
    expect(res.body.closingPositions[0]).toMatchObject({
      positionId: created.id,
      phase: 'QUOTE_UNAVAILABLE',
      operatorActionRequired: true,
      tokenResidualRaw: RESIDUAL.toString(),
      usdgRecoveredRaw: USDG(200).toString(),
    });
    expect(res.body.closingPositions[0].closingAgeMs).toBeGreaterThanOrEqual(2 * STUCK_AGE);
  });

  it('(G) operator authorization: the stuck surface is not readable without a valid token (existing JWT middleware); there is no unauthenticated or state-changing recovery endpoint', async () => {
    const { app } = buildTestApp();
    expect((await request(app).get('/positions/stuck')).status).toBe(401);
    expect((await request(app).get('/positions/stuck').set('Authorization', 'Bearer not-a-valid-token')).status).toBe(401);
    // No force-close / settle route exists at all (a DB status change is not a settlement).
    for (const path of ['/positions/force-close', '/positions/settle', '/positions/stuck/resolve']) {
      expect([401, 404]).toContain((await request(app).post(path).set('Authorization', authHeader())).status);
    }
  });
});

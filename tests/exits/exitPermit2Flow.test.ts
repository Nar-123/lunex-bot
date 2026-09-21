import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Address } from 'viem';
import { executeExit, type ExecuteExitDeps } from '../../src/exits/executeExit';
import { assessTokenGrant, type TokenGrantAssessment } from '../../src/exits/permit2TokenGrant';
import { decodeBlockReason } from '../../src/exits/swapLegBackoff';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { makeCreateInput } from '../positions/fixtures';
import { EXECUTION_TARGETS } from '../../src/config/constants';

/**
 * The Permit2-enabled exit flow as a STATE MACHINE:
 *
 *   pre-flight -> Permit2 grant (only if needed) -> VERIFIED -> simulate -> swap -> verify
 *
 * The grant leg is a critical transaction of its own, so everything the
 * executor guarantees (idempotency, receipt recovery, no re-sign) applies to it.
 * These tests pin the ORDERING and the failure boundaries.
 */
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const UR = getAddress(EXECUTION_TARGETS[4663]!.universalRouters[0]!);
const U = (n: number): bigint => BigInt(n) * 10n ** 18n;
const TX: TxRequest = { to: UR, data: '0x3593564c', value: 0n };
const NOW = Math.floor(Date.now() / 1000);
const TARGETS = { chainId: 4663, universalRouters: [UR], swapProxies: [] as string[] };

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
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data })),
    ...overrides,
  };
}

const quote = (): SwapQuote => ({ amountInRaw: U(500), expectedAmountOutRaw: U(490), minOutputAmountRaw: U(480), priceImpactPct: 0.001, slippageBps: 100, providerQuote: {}, permitDataPresent: true });
const executor = (): SwapExecutor => ({ getQuote: vi.fn(async () => quote()), checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })), buildSwapTx: vi.fn() });

/** A real assessment, so the grant calldata/expiration used by the leg is the production encoder's. */
function grantState(amount: bigint, expiration: number): TokenGrantAssessment {
  return assessTokenGrant({
    readFor: { owner: WALLET, token: TOKEN, spender: UR }, expectedOwner: WALLET, expectedToken: TOKEN, spender: UR, targets: TARGETS,
    grant: { amount, expiration, nonce: 0 }, requiredAmount: U(500), chainTimestamp: NOW,
  });
}
const MISSING = () => grantState(0n, 0);
const SUFFICIENT = () => grantState(U(500), NOW + 86_400);
const EXPIRED = () => grantState(U(5000), NOW - 1);

async function scenario() {
  const positions = new InMemoryPositionRepository();
  const exitStates = new InMemoryExitStateRepository();
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const created = await positions.create(makeCreateInput({ entryUsdgRaw: U(500), tokenAddress: TOKEN }));
  await positions.markActive(created.id, '1', new Date());
  await positions.markClosing(created.id, `exit:${created.id}:k`);
  const position = (await positions.findById(created.id))!;
  exitStates.seed({
    positionId: position.id, pendingCloseReason: 'HARD_STOP_LOSS', swapAttemptCount: 0, trailingPeakPnlPct: null, drawdownConfirmStartedAt: null,
    oorStartedAt: null, safetyExitArmedAt: null, maxDrawdownPnlPct: null, metricsFailureSince: null, swapUsdgBalanceBeforeRaw: null,
    swapMinOutputAmountRaw: null, swapVerifiedUsdgIncreaseRaw: null, swapLegBlockedReason: null, swapLegBlockedSince: null, swapLegLastCheckedAt: null,
  } as never);
  const remove = await txAttempts.create(`${position.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
  await txAttempts.update(remove.id, { status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: U(400).toString(), tokenProceedsRaw: U(5).toString() } });
  return { positions, exitStates, txAttempts, position };
}
type Ctx = Awaited<ReturnType<typeof scenario>>;

/** Records the order legs are invoked in, across both the grant and the swap. */
function harness(ctx: Ctx, o: { grant?: () => TokenGrantAssessment; grantDeps?: Partial<TxSafetyDeps<unknown>>; sim?: { ok: true } | { ok: false; reason: string }; swapDeps?: Partial<TxSafetyDeps<unknown>> } = {}) {
  const order: string[] = [];
  const grantSign = vi.fn(async () => { order.push('grant:sign'); return { raw: '0x01' as `0x${string}`, hash: `0x${'11'.repeat(32)}` as `0x${string}` }; });
  const swapSign = vi.fn(async () => { order.push('swap:sign'); return { raw: '0x02' as `0x${string}`, hash: `0x${'22'.repeat(32)}` as `0x${string}` }; });
  const buildTokenGrantDeps = vi.fn((_a: NonNullable<TokenGrantAssessment['approval']>) =>
    fakeTxDeps({ amount: U(500).toString(), expiration: NOW + 86_400, nonce: 0 }, { signTransaction: grantSign, ...(o.grantDeps as object) }));
  const buildSwapDeps = vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: U(490), usdgProceedsRaw: U(490) }, { signTransaction: swapSign, ...(o.swapDeps as object) }));
  const simulateSwap = vi.fn(async () => { order.push('swap:simulate'); return o.sim ?? ({ ok: true } as const); });
  const tokenGrantPreflight = vi.fn(async () => { order.push('grant:preflight'); return (o.grant ?? MISSING)(); });
  const deps: ExecuteExitDeps = {
    positions: ctx.positions, exitStates: ctx.exitStates, txAttempts: ctx.txAttempts,
    livePositionState: { getLiveState: vi.fn() }, poolPrice: { getPriceState: vi.fn() },
    swapExecutor: executor(), readTokenBalance: vi.fn(async () => U(500)), readAllowance: vi.fn(async () => U(1000)), walletAddress: WALLET,
    tokenGrantPreflight, buildTokenGrantDeps: buildTokenGrantDeps as never, simulateSwap,
    buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: U(400) })),
    buildSwapDeps: buildSwapDeps as never,
    buildApproveDeps: vi.fn(() => fakeTxDeps({ allowanceRaw: U(500) })),
    warnLog: vi.fn(),
  };
  return { deps, order, grantSign, swapSign, buildTokenGrantDeps, buildSwapDeps, simulateSwap, tokenGrantPreflight };
}
const grantRows = async (ctx: Ctx) => (await ctx.txAttempts.findByKeyPrefixes(['permit2:exit:'])).length;

describe('18. ordering: pre-flight -> grant -> verified -> simulate -> swap', () => {
  it('a missing grant is created and verified BEFORE the swap is simulated or signed', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { grant: MISSING });
    const out = await executeExit(ctx.position, h.deps);

    expect(out.outcome).toBe('CLOSED');
    expect(h.order).toEqual(['grant:preflight', 'grant:sign', 'swap:simulate', 'swap:sign']);
    expect(await grantRows(ctx)).toBe(1);
    const row = (await ctx.txAttempts.findByKeyPrefixes(['permit2:exit:']))[0]!;
    expect(row.status).toBe('VERIFIED');
    expect(row.purpose).toBe('exit:permit2Grant');
  });

  it('13. a sufficient grant skips the approval leg entirely', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { grant: SUFFICIENT });
    expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');
    expect(h.buildTokenGrantDeps).not.toHaveBeenCalled();
    expect(h.grantSign).not.toHaveBeenCalled();
    expect(await grantRows(ctx)).toBe(0);
    expect(h.order).toEqual(['grant:preflight', 'swap:simulate', 'swap:sign']);
  });

  it('14. an expired grant creates the approval leg, then swaps', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { grant: EXPIRED });
    expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');
    expect(h.order).toEqual(['grant:preflight', 'grant:sign', 'swap:simulate', 'swap:sign']);
  });
});

describe('19-20. approval failure never lets a swap be built', () => {
  it('19. a DEFINITIVE approval failure blocks the swap and leaves the position recoverable', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { grantDeps: { simulate: vi.fn(async () => ({ ok: false, reason: 'reverted' }) as const) } });
    const out = await executeExit(ctx.position, h.deps);

    expect(out.outcome).toBe('SWAP_FAILED_RETRY_PENDING');
    expect(h.buildSwapDeps).not.toHaveBeenCalled();
    expect(h.swapSign).not.toHaveBeenCalled();
    expect(h.simulateSwap).not.toHaveBeenCalled();
    const p = await ctx.positions.findById(ctx.position.id);
    expect(p?.status).toBe('CLOSING'); // never closed on an approval failure
  });

  it('20. an AMBIGUOUS approval (broadcast outcome unknown) is resumable, and the swap is not attempted', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { grantDeps: { broadcastRaw: vi.fn(async () => { throw new Error('socket hang up'); }) } });
    const out = await executeExit(ctx.position, h.deps);

    expect(out.outcome).toBe('PENDING');
    expect(h.swapSign).not.toHaveBeenCalled();
    const row = (await ctx.txAttempts.findByKeyPrefixes(['permit2:exit:']))[0]!;
    expect(['SIGNED', 'SENT']).toContain(row.status); // persisted before the broadcast -- recoverable by receipt
    expect(row.nonce).not.toBeNull();
  });

  it('20b. recovery: the next tick resumes the SAME grant attempt by receipt and never signs it again', async () => {
    const ctx = await scenario();
    const first = harness(ctx, { grantDeps: { broadcastRaw: vi.fn(async () => { throw new Error('socket hang up'); }) } });
    await executeExit(ctx.position, first.deps);
    expect(first.grantSign).toHaveBeenCalledTimes(1);

    // the receipt is now available on-chain
    const second = harness(ctx, { grantDeps: { getReceiptIfAvailable: vi.fn(async () => ({ status: 'success' as const, blockNumber: 2n })) } });
    const out = await executeExit(ctx.position, second.deps);

    expect(second.grantSign).not.toHaveBeenCalled(); // the signed payload was reused, not re-signed
    expect(out.outcome).toBe('CLOSED');
    expect(await grantRows(ctx)).toBe(1);
  });

  it('a pre-flight READ failure is PENDING -- never treated as "no grant" and approved blindly', async () => {
    const ctx = await scenario();
    const h = harness(ctx);
    (h.deps as { tokenGrantPreflight: unknown }).tokenGrantPreflight = vi.fn(async () => { throw new Error('rpc down'); });
    const out = await executeExit(ctx.position, h.deps);
    expect(out).toMatchObject({ outcome: 'PENDING' });
    expect((out as { reason: string }).reason).toMatch(/could not be read/);
    expect(h.buildTokenGrantDeps).not.toHaveBeenCalled();
    expect(h.buildSwapDeps).not.toHaveBeenCalled();
  });

  it('a WRONG_* pre-flight is a deterministic block -- no approval, no swap, backoff engaged', async () => {
    const ctx = await scenario();
    const wrong = (): TokenGrantAssessment => ({ ...MISSING(), status: 'WRONG_SPENDER', needsApproval: false, approval: null, reason: 'spender not allowlisted' });
    const h = harness(ctx, { grant: wrong });
    const out = await executeExit(ctx.position, h.deps);
    expect(out.outcome).toBe('PENDING');
    expect(h.buildTokenGrantDeps).not.toHaveBeenCalled();
    expect(h.buildSwapDeps).not.toHaveBeenCalled();
    const st = await ctx.exitStates.getOrCreate(ctx.position.id);
    expect(decodeBlockReason(st.swapLegBlockedReason).reason).toBe('APPROVAL_SPENDER_NOT_APPROVED');
  });
});

describe('21-22. duplicates and resumption', () => {
  it('21. two concurrent exits of the same position create ONE grant attempt, not two', async () => {
    const ctx = await scenario();
    const a = harness(ctx);
    const b = harness(ctx);
    await Promise.all([executeExit(ctx.position, a.deps), executeExit(ctx.position, b.deps)]);
    expect(await grantRows(ctx)).toBe(1);
    expect(a.grantSign.mock.calls.length + b.grantSign.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('22. a grant already VERIFIED is resumed, not re-sent -- even when a stale pre-flight still says "missing"', async () => {
    const ctx = await scenario();
    const first = harness(ctx, { swapDeps: { simulate: vi.fn(async () => ({ ok: false, reason: 'transient' }) as const) } });
    await executeExit(ctx.position, first.deps); // grant reaches VERIFIED; the swap then fails
    expect(first.grantSign).toHaveBeenCalledTimes(1);
    const [row] = await ctx.txAttempts.findByKeyPrefixes(['permit2:exit:']);
    expect(row?.status).toBe('VERIFIED');

    // the pre-flight is stale (reports MISSING again), so the leg re-derives the SAME key...
    const second = harness(ctx, { grant: MISSING });
    await executeExit(ctx.position, second.deps);

    // ...and the executor returns the cached VERIFIED result instead of signing again
    expect(second.grantSign).not.toHaveBeenCalled();
    const rows = await ctx.txAttempts.findByKeyPrefixes(['permit2:exit:']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(row?.id);
    expect(rows[0]?.attemptCount).toBe(1);
  });
});

describe('23-24. the simulation gate', () => {
  it('23. a failing simulation blocks the swap BEFORE any signature', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { grant: SUFFICIENT, sim: { ok: false, reason: 'execution reverted: TRANSFER_FROM_FAILED' } });
    const out = await executeExit(ctx.position, h.deps);
    expect(out.outcome).toBe('PENDING');
    expect((out as { reason: string }).reason).toMatch(/simulation failed, not signing/);
    expect(h.swapSign).not.toHaveBeenCalled();
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });

  it('24. a passing simulation lets the swap proceed', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { grant: SUFFICIENT, sim: { ok: true } });
    expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');
    expect(h.swapSign).toHaveBeenCalledTimes(1);
  });

  it('the gate is wired ON in production composition', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const text = readFileSync(path.resolve(__dirname, '../../src/composition/exitCycle.ts'), 'utf8');
    expect(text).toMatch(/simulateSwap:\s*deps\.simulateSwap\s*\?\?\s*\(\(tx, from\) => simulateExitSwap\(tx, from\)\)/);
  });
});

describe('28-30. the rest of the exit machine is unharmed', () => {
  it('28. a deterministic swap-target failure still engages the backoff', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { grant: SUFFICIENT, swapDeps: { buildTransaction: vi.fn(async () => { throw new Error('SwapQuoteValidationError: swap tx "to" (0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9) is not an approved execution target for chain 4663'); }) } });
    await executeExit(ctx.position, h.deps);
    const st = await ctx.exitStates.getOrCreate(ctx.position.id);
    expect(decodeBlockReason(st.swapLegBlockedReason).reason).toBe('TARGET_NOT_APPROVED');
    expect(h.swapSign).not.toHaveBeenCalled();
  });

  it('29. a failed exit never changes realized proceeds or capital; a grant alone never closes a position', async () => {
    const ctx = await scenario();
    const before = await ctx.positions.findById(ctx.position.id);
    const h = harness(ctx, { sim: { ok: false, reason: 'reverted' } });
    await executeExit(ctx.position, h.deps);
    const after = await ctx.positions.findById(ctx.position.id);
    expect(after?.status).toBe('CLOSING');
    expect(after?.realizedUsdgRaw).toEqual(before?.realizedUsdgRaw);
    expect(after?.entryUsdgRaw).toEqual(before?.entryUsdgRaw);
  });

  it('30. no fake swap success: a swap whose verification fails does not close the position', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { grant: SUFFICIENT, swapDeps: { verifyOnChain: vi.fn(async () => ({ ok: false as const, reason: 'no USDG received' })) } });
    const out = await executeExit(ctx.position, h.deps);
    expect(out.outcome).not.toBe('CLOSED');
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });
});

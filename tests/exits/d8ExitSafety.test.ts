import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Address } from 'viem';
import { executeExit, receiptTokenProceedsRaw, type ExecuteExitDeps } from '../../src/exits/executeExit';
import {
  assessTokenGrant,
  resolveTokenGrantRetryGeneration,
  tokenGrantIdempotencyKey,
  tokenGrantKeyPrefix,
  TOKEN_GRANT_RETRY_GENERATION_LIMIT,
  type TokenGrantAssessment,
} from '../../src/exits/permit2TokenGrant';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { makeCreateInput } from '../positions/fixtures';
import { EXECUTION_TARGETS } from '../../src/config/constants';

/**
 * D8 regression suite for the two exit-flow blockers:
 *
 *   FIX 1 -- the amount to sell was re-derived from the WALLET-WIDE TOKEN
 *            balance (`amountInRaw ??= readTokenBalance(...)`), so an exit
 *            could sell -- and grant the router Permit2 authority over --
 *            TOKEN belonging to another position or arriving from anywhere else.
 *   FIX 2 -- the grant's idempotency key was derived only from the on-chain
 *            expiration it replaced. A definitive approval failure left that
 *            expiration unchanged, so every later tick re-derived the same key
 *            and re-read its cached FAILED row: the grant, and with it the
 *            swap, could never be retried.
 */
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const UR = getAddress(EXECUTION_TARGETS[4663]!.universalRouters[0]!);
const TARGETS = { chainId: 4663, universalRouters: [UR], swapProxies: [] as string[] };
const U = (n: number): bigint => BigInt(n) * 10n ** 18n;
const TX: TxRequest = { to: UR, data: '0x3593564c', value: 0n };
const NOW = Math.floor(Date.now() / 1000);

/** The two amounts the whole FIX 1 story turns on. */
const RECEIPT_TOKEN = U(100); // what THIS position's remove-liquidity receipt paid
const WALLET_TOKEN = U(150); // what the wallet happens to hold (100 of it ours)

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

/** A REAL assessment, so the approval amount/calldata is the production encoder's. */
function grantState(amount: bigint, expiration: number, requiredAmount: bigint): TokenGrantAssessment {
  return assessTokenGrant({
    readFor: { owner: WALLET, token: TOKEN, spender: UR },
    expectedOwner: WALLET,
    expectedToken: TOKEN,
    spender: UR,
    targets: TARGETS,
    grant: { amount, expiration, nonce: 0 },
    requiredAmount,
    chainTimestamp: NOW,
  });
}

async function scenario(receiptTokenRaw: bigint = RECEIPT_TOKEN) {
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
  // remove-liquidity ALREADY VERIFIED, with the receipt-scoped TOKEN it paid out
  const remove = await txAttempts.create(`${position.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
  await txAttempts.update(remove.id, { status: 'VERIFIED', txHash: `0x${'ee'.repeat(32)}`, verifyData: { liquidityZero: true, usdgProceedsRaw: U(400), tokenProceedsRaw: receiptTokenRaw } });
  return { positions, exitStates, txAttempts, position };
}
type Ctx = Awaited<ReturnType<typeof scenario>>;

interface HarnessOptions {
  walletTokenRaw?: bigint;
  /** The live grant state the pre-flight reports; defaults to "missing" (needs an approval). */
  grant?: (requiredAmount: bigint) => TokenGrantAssessment;
  grantDeps?: Partial<TxSafetyDeps<unknown>>;
  swapDeps?: Partial<TxSafetyDeps<unknown>>;
  legacyReceipt?: boolean;
  readTransfersTo?: ExecuteExitDeps['readTransfersTo'];
}

function harness(ctx: Ctx, o: HarnessOptions = {}) {
  const order: string[] = [];
  const quotedAmounts: bigint[] = [];
  const grantRequiredAmounts: bigint[] = [];
  const approvedAmounts: bigint[] = [];
  const grantSign = vi.fn(async () => { order.push('grant:sign'); return { raw: '0x01' as `0x${string}`, hash: `0x${'11'.repeat(32)}` as `0x${string}` }; });
  const swapSign = vi.fn(async () => { order.push('swap:sign'); return { raw: '0x02' as `0x${string}`, hash: `0x${'22'.repeat(32)}` as `0x${string}` }; });
  const quote = (amountInRaw: bigint): SwapQuote => ({
    amountInRaw, expectedAmountOutRaw: U(98), minOutputAmountRaw: U(97), priceImpactPct: 0.001, slippageBps: 100, providerQuote: {}, permitDataPresent: true,
  });
  const swapExecutor: SwapExecutor = {
    getQuote: vi.fn(async (_t: Address, amountInRaw: bigint) => { quotedAmounts.push(amountInRaw); return quote(amountInRaw); }),
    checkApproval: vi.fn(async () => ({ needsApproval: false, spender: null })),
    buildSwapTx: vi.fn(),
  };
  const tokenGrantPreflight = vi.fn(async (_token: Address, requiredAmount: bigint) => {
    order.push('grant:preflight');
    grantRequiredAmounts.push(requiredAmount);
    return (o.grant ?? ((req: bigint) => grantState(0n, 0, req)))(requiredAmount);
  });
  const buildTokenGrantDeps = vi.fn((approval: NonNullable<TokenGrantAssessment['approval']>, requiredAmount: bigint) => {
    approvedAmounts.push(approval.amount);
    grantRequiredAmounts.push(requiredAmount);
    return fakeTxDeps({ amount: approval.amount.toString(), expiration: approval.expiration, nonce: 0 }, { signTransaction: grantSign, ...(o.grantDeps as object) });
  });
  const deps: ExecuteExitDeps = {
    positions: ctx.positions, exitStates: ctx.exitStates, txAttempts: ctx.txAttempts,
    livePositionState: { getLiveState: vi.fn() }, poolPrice: { getPriceState: vi.fn() },
    swapExecutor,
    readTokenBalance: vi.fn(async () => o.walletTokenRaw ?? WALLET_TOKEN),
    readAllowance: vi.fn(async () => U(1000)),
    walletAddress: WALLET,
    tokenGrantPreflight,
    buildTokenGrantDeps: buildTokenGrantDeps as never,
    buildRemoveLiquidityDeps: vi.fn(() =>
      fakeTxDeps(
        o.legacyReceipt
          ? ({ liquidityZero: true, usdgProceedsRaw: U(400) } as never) // legacy: no tokenProceedsRaw
          : ({ liquidityZero: true, usdgProceedsRaw: U(400), tokenProceedsRaw: RECEIPT_TOKEN } as never),
      ),
    ),
    buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: U(98), usdgProceedsRaw: U(98) }, { signTransaction: swapSign, ...(o.swapDeps as object) })) as never,
    buildApproveDeps: vi.fn(() => fakeTxDeps({ allowanceRaw: U(1000) })),
    readTransfersTo: o.readTransfersTo,
    warnLog: vi.fn(),
  };
  return { deps, order, quotedAmounts, grantRequiredAmounts, approvedAmounts, grantSign, swapSign, tokenGrantPreflight, buildTokenGrantDeps, swapExecutor };
}

const grantRows = (ctx: Ctx) => ctx.txAttempts.findByKeyPrefixes(['permit2:exit:']);
const swapRows = (ctx: Ctx) => ctx.txAttempts.findByKeyPrefixes([`${ctx.position.closeIdempotencyKey}:swap:`]);
/** A definitively failing leg: the simulation rejects it, before anything is signed. */
const definitiveFailure = (reason = 'execution reverted: PERMIT2_APPROVE_FAILED'): Partial<TxSafetyDeps<unknown>> => ({ simulate: vi.fn(async () => ({ ok: false as const, reason })) });

describe('FIX 1 -- an exit sells the RECEIPT amount, never the wallet-wide TOKEN balance', () => {
  it('receipt 100, wallet 150 -> swaps 100, grants Permit2 for exactly 100, quotes 100; 150 is never approved or swapped', async () => {
    const ctx = await scenario(RECEIPT_TOKEN);
    const h = harness(ctx, { walletTokenRaw: WALLET_TOKEN });

    const out = await executeExit(ctx.position, h.deps);

    expect(out).toEqual({ outcome: 'CLOSED' });
    // the quote asked for the receipt amount
    expect(h.quotedAmounts).toEqual([RECEIPT_TOKEN]);
    expect(h.swapExecutor.getQuote).toHaveBeenCalledWith(TOKEN, RECEIPT_TOKEN, 100);
    // the Permit2 grant required -- and approved -- exactly the receipt amount
    expect(new Set(h.grantRequiredAmounts)).toEqual(new Set([RECEIPT_TOKEN]));
    expect(h.approvedAmounts).toEqual([RECEIPT_TOKEN]);
    // and nothing anywhere used the wallet-wide 150
    expect(h.quotedAmounts).not.toContain(WALLET_TOKEN);
    expect(h.grantRequiredAmounts).not.toContain(WALLET_TOKEN);
    expect(h.approvedAmounts).not.toContain(WALLET_TOKEN);
    expect(JSON.stringify([...h.quotedAmounts, ...h.approvedAmounts].map(String))).not.toContain(WALLET_TOKEN.toString());
  });

  it('receipt 100, wallet 50 -> fails closed with PENDING: no quote, no grant, no swap for 50', async () => {
    const ctx = await scenario(RECEIPT_TOKEN);
    const h = harness(ctx, { walletTokenRaw: U(50) });

    const out = await executeExit(ctx.position, h.deps);

    expect(out.outcome).toBe('PENDING');
    if (out.outcome === 'PENDING') expect(out.reason).toMatch(/receipt paid 100000000000000000000 TOKEN but the wallet holds only 50000000000000000000/);
    expect(h.swapExecutor.getQuote).not.toHaveBeenCalled();
    expect(h.tokenGrantPreflight).not.toHaveBeenCalled();
    expect(h.grantSign).not.toHaveBeenCalled();
    expect(h.swapSign).not.toHaveBeenCalled();
    expect(await swapRows(ctx)).toHaveLength(0);
    expect(await grantRows(ctx)).toHaveLength(0);
    // the position is left CLOSING for an operator, not closed and not reverted
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });

  it('an exact match (receipt 100, wallet 100) still proceeds -- the balance check is a floor, not an equality', async () => {
    const ctx = await scenario(RECEIPT_TOKEN);
    const h = harness(ctx, { walletTokenRaw: RECEIPT_TOKEN });
    expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');
    expect(h.quotedAmounts).toEqual([RECEIPT_TOKEN]);
  });

  it('a LEGACY attempt with no recorded TOKEN proceeds re-reads its own receipt, and sells THAT amount', async () => {
    const ctx = await scenario(RECEIPT_TOKEN);
    // the persisted row predates tokenProceedsRaw; the receipt says 100 was paid
    const remove = (await ctx.txAttempts.find(`${ctx.position.closeIdempotencyKey}:removeLiquidity`))!;
    await ctx.txAttempts.update(remove.id, { verifyData: { liquidityZero: true, usdgProceedsRaw: U(400) } });
    const readTransfersTo = vi.fn(async (_h: `0x${string}`, token: Address) => (token.toLowerCase() === TOKEN.toLowerCase() ? RECEIPT_TOKEN : U(400)));
    const h = harness(ctx, { walletTokenRaw: WALLET_TOKEN, legacyReceipt: true, readTransfersTo });

    expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');
    expect(readTransfersTo).toHaveBeenCalled();
    expect(h.quotedAmounts).toEqual([RECEIPT_TOKEN]); // the receipt's amount, never the wallet's 150
  });

  it('a legacy attempt whose receipt cannot be re-read defers -- it never falls back to the wallet balance', async () => {
    const ctx = await scenario(RECEIPT_TOKEN);
    const remove = (await ctx.txAttempts.find(`${ctx.position.closeIdempotencyKey}:removeLiquidity`))!;
    await ctx.txAttempts.update(remove.id, { verifyData: { liquidityZero: true, usdgProceedsRaw: U(400) } });
    const h = harness(ctx, {
      walletTokenRaw: WALLET_TOKEN,
      legacyReceipt: true,
      readTransfersTo: vi.fn(async () => { throw new Error('RPC down'); }),
    });

    const out = await executeExit(ctx.position, h.deps);
    expect(out.outcome).toBe('PENDING');
    expect(h.swapExecutor.getQuote).not.toHaveBeenCalled();
  });

  it('receiptTokenProceedsRaw reads every shape the row can hold, and refuses to guess at anything else', () => {
    expect(receiptTokenProceedsRaw({ tokenProceedsRaw: 5n })).toBe(5n);
    expect(receiptTokenProceedsRaw({ tokenProceedsRaw: 0n })).toBe(0n);
    expect(receiptTokenProceedsRaw({ tokenProceedsRaw: 'bigint:7' })).toBe(7n); // the repository's tagged round-trip
    expect(receiptTokenProceedsRaw({ tokenProceedsRaw: '9' })).toBe(9n); // a legacy plain decimal string
    expect(receiptTokenProceedsRaw({ tokenProceedsRaw: -1n })).toBeNull();
    expect(receiptTokenProceedsRaw({ tokenProceedsRaw: 12 })).toBeNull(); // a number is NOT trusted (precision)
    expect(receiptTokenProceedsRaw({ tokenProceedsRaw: 'abc' })).toBeNull();
    expect(receiptTokenProceedsRaw({ usdgProceedsRaw: 1n })).toBeNull();
    expect(receiptTokenProceedsRaw(null)).toBeNull();
  });
});

describe('FIX 2 -- a definitively failed Permit2 grant is retryable under a NEW key', () => {
  it('A. missing grant -> approval FAILS definitively -> the next executeExit creates a NEW grant attempt and retries the approval', async () => {
    const ctx = await scenario();
    const first = harness(ctx, { grantDeps: definitiveFailure() });
    const out1 = await executeExit(ctx.position, first.deps);

    expect(out1.outcome).toBe('SWAP_FAILED_RETRY_PENDING');
    const after1 = await grantRows(ctx);
    expect(after1).toHaveLength(1);
    expect(after1[0]!.status).toBe('FAILED');
    expect(after1[0]!.idempotencyKey.endsWith(':r0')).toBe(true);

    // next tick: the same lifecycle, the same still-missing grant
    const current = (await ctx.positions.findById(ctx.position.id))!;
    const second = harness(ctx);
    const out2 = await executeExit(current, second.deps);

    expect(out2.outcome).toBe('CLOSED');
    expect(second.grantSign).toHaveBeenCalledTimes(1); // the approval really was re-attempted
    const after2 = await grantRows(ctx);
    expect(after2).toHaveLength(2);
    expect(after2.map((r) => r.idempotencyKey).some((k) => k.endsWith(':r1'))).toBe(true);
    expect(new Set(after2.map((r) => r.idempotencyKey)).size).toBe(2);
    // the failed row is untouched -- never reused, never rewritten
    expect((await ctx.txAttempts.find(after1[0]!.idempotencyKey))!.status).toBe('FAILED');
  });

  it('A2. a SECOND definitive failure advances again -- the retry never reuses a failed key', async () => {
    const ctx = await scenario();
    await executeExit(ctx.position, harness(ctx, { grantDeps: definitiveFailure() }).deps);
    const current = (await ctx.positions.findById(ctx.position.id))!;
    await executeExit(current, harness(ctx, { grantDeps: definitiveFailure('reverted again') }).deps);

    const rows = await grantRows(ctx);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'FAILED')).toBe(true);
    expect(rows.map((r) => r.idempotencyKey.slice(-3)).sort()).toEqual([':r0', ':r1']);

    // and a third tick gets a third, still-fresh key
    const third = harness(ctx);
    expect((await executeExit((await ctx.positions.findById(ctx.position.id))!, third.deps)).outcome).toBe('CLOSED');
    const finalRows = await grantRows(ctx);
    expect(finalRows).toHaveLength(3);
    expect(finalRows.some((r) => r.idempotencyKey.endsWith(':r2') && r.status === 'VERIFIED')).toBe(true);
  });

  it('B. a crash AFTER the approval was SIGNED reuses the SAME key and never signs twice', async () => {
    const ctx = await scenario();
    // broadcast is ambiguous: the row keeps its signed payload and stays resumable
    const first = harness(ctx, { grantDeps: { broadcastRaw: vi.fn(async () => { throw new Error('ECONNRESET'); }) } });
    const out1 = await executeExit(ctx.position, first.deps);
    expect(out1.outcome).toBe('PENDING');
    const [signedRow] = await grantRows(ctx);
    expect(signedRow!.rawTx).not.toBeNull();
    expect(first.grantSign).toHaveBeenCalledTimes(1);

    // "restart": a fresh worker, same persisted state
    const second = harness(ctx);
    await executeExit((await ctx.positions.findById(ctx.position.id))!, second.deps);

    const rows = await grantRows(ctx);
    expect(rows).toHaveLength(1); // SAME key -- no new generation for an ambiguous outcome
    expect(rows[0]!.idempotencyKey).toBe(signedRow!.idempotencyKey);
    expect(second.grantSign).not.toHaveBeenCalled(); // never re-signed
  });

  it('C. two concurrent exits produce ONE grant transaction, under one key', async () => {
    const ctx = await scenario();
    const a = harness(ctx);
    const b = harness(ctx);
    const [ra, rb] = await Promise.all([executeExit(ctx.position, a.deps), executeExit(ctx.position, b.deps)]);

    const signs = a.grantSign.mock.calls.length + b.grantSign.mock.calls.length;
    expect(signs).toBe(1);
    expect(await grantRows(ctx)).toHaveLength(1);
    // one worker did the work; the other deferred rather than duplicating it
    expect([ra.outcome, rb.outcome].filter((o) => o === 'PENDING').length).toBe(1);
  });

  it('D. a grant that is already VERIFIED/sufficient produces no second approval at all', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { grant: (req) => grantState(req, NOW + 86_400, req) }); // covers the amount, far from expiry
    const out = await executeExit(ctx.position, h.deps);

    expect(out.outcome).toBe('CLOSED');
    expect(h.grantSign).not.toHaveBeenCalled();
    expect(await grantRows(ctx)).toHaveLength(0);
  });

  it('E. a grant that expires again LATER in the same lifecycle gets a new key (generation restarts for the new expiration)', async () => {
    const ctx = await scenario();
    // The first tick's grant lands, but its SWAP fails definitively, so the same
    // close lifecycle is still open when the grant later expires.
    const first = harness(ctx, { swapDeps: definitiveFailure('swap reverted') });
    await executeExit(ctx.position, first.deps);
    expect(first.grantSign).toHaveBeenCalledTimes(1);
    const afterFirst = await grantRows(ctx);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.idempotencyKey.endsWith(':from0:r0')).toBe(true);

    // much later: that grant (expiration E1) has itself expired
    const E1 = NOW + 86_400;
    const second = harness(ctx, {
      // read at a chain time PAST E1, so the grant it holds is itself expired
      grant: (req) =>
        assessTokenGrant({
          readFor: { owner: WALLET, token: TOKEN, spender: UR }, expectedOwner: WALLET, expectedToken: TOKEN, spender: UR, targets: TARGETS,
          grant: { amount: req, expiration: E1, nonce: 1 }, requiredAmount: req, chainTimestamp: E1 + 60,
        }),
    });
    await executeExit((await ctx.positions.findById(ctx.position.id))!, second.deps);

    const rows = await grantRows(ctx);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.idempotencyKey.endsWith(`:from${E1}:r0`))).toBe(true);
    expect(second.grantSign).toHaveBeenCalledTimes(1);
  });

  it('F. an approval that fails NEVER proceeds to the swap', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { grantDeps: definitiveFailure() });
    const out = await executeExit(ctx.position, h.deps);

    expect(out.outcome).toBe('SWAP_FAILED_RETRY_PENDING');
    expect(h.swapSign).not.toHaveBeenCalled();
    expect(await swapRows(ctx)).toHaveLength(0);
    expect(h.order).toEqual(['grant:preflight']); // never reached swap:simulate / swap:sign
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });

  it('the retry limit is finite: past it the exit defers for an operator instead of approving forever', async () => {
    const ctx = await scenario();
    const prefix = tokenGrantKeyPrefix(ctx.position.closeIdempotencyKey!, 4663, TOKEN, UR, 0);
    for (let g = 0; g < TOKEN_GRANT_RETRY_GENERATION_LIMIT; g += 1) {
      const row = await ctx.txAttempts.create(`${prefix}${g}`, 'exit:permit2Grant');
      await ctx.txAttempts.update(row.id, { status: 'FAILED', failureCode: 'REVERTED', lastError: 'reverted' });
    }
    const h = harness(ctx);
    const out = await executeExit(ctx.position, h.deps);

    expect(out.outcome).toBe('PENDING');
    if (out.outcome === 'PENDING') expect(out.reason).toMatch(/OPERATOR ACTION REQUIRED/);
    expect(h.grantSign).not.toHaveBeenCalled();
    expect(h.swapSign).not.toHaveBeenCalled();
    expect(await grantRows(ctx)).toHaveLength(TOKEN_GRANT_RETRY_GENERATION_LIMIT); // nothing new was created
  });
});

describe('FIX 2 -- the generation rule itself (pure, so every state is pinned explicitly)', () => {
  const prefix = tokenGrantKeyPrefix('exit:p:1', 4663, TOKEN, UR, 0);
  const row = (generation: number, status: string) => ({ idempotencyKey: `${prefix}${generation}`, status });

  it('no attempts yet -> generation 0', () => {
    expect(resolveTokenGrantRetryGeneration([], prefix)).toBe(0);
  });

  it('only a DEFINITIVE failure advances it', () => {
    expect(resolveTokenGrantRetryGeneration([row(0, 'FAILED')], prefix)).toBe(1);
    expect(resolveTokenGrantRetryGeneration([row(0, 'FAILED'), row(1, 'FAILED')], prefix)).toBe(2);
  });

  it.each(['PENDING', 'BUILT', 'SIMULATED', 'GAS_CHECKED', 'NONCE_ASSIGNED', 'SIGNED', 'SENT', 'CONFIRMED', 'VERIFIED'])(
    'a %s attempt does NOT advance it -- a crash, an RPC timeout or a restart resumes the SAME key',
    (status) => {
      expect(resolveTokenGrantRetryGeneration([row(0, status)], prefix)).toBe(0);
    },
  );

  it('two concurrent workers reading the same rows derive the SAME generation', () => {
    const rows = [row(0, 'FAILED'), row(1, 'SIGNED')];
    expect(resolveTokenGrantRetryGeneration(rows, prefix)).toBe(resolveTokenGrantRetryGeneration([...rows].reverse(), prefix));
    expect(resolveTokenGrantRetryGeneration(rows, prefix)).toBe(1);
  });

  it('attempts belonging to a DIFFERENT expiration, token or lifecycle are ignored, never counted', () => {
    const other = tokenGrantKeyPrefix('exit:p:1', 4663, TOKEN, UR, 999);
    expect(resolveTokenGrantRetryGeneration([{ idempotencyKey: `${other}0`, status: 'FAILED' }], prefix)).toBe(0);
    // a numerically-similar expiration must not match as a prefix either
    const similar = tokenGrantKeyPrefix('exit:p:1', 4663, TOKEN, UR, 12);
    expect(`${similar}0`.startsWith(tokenGrantKeyPrefix('exit:p:1', 4663, TOKEN, UR, 1))).toBe(false);
  });

  it('a non-numeric suffix is ignored rather than guessed at', () => {
    expect(resolveTokenGrantRetryGeneration([{ idempotencyKey: `${prefix}abc`, status: 'FAILED' }], prefix)).toBe(0);
  });

  it('gaps are handled deterministically: the lowest generation not already FAILED wins', () => {
    expect(resolveTokenGrantRetryGeneration([row(1, 'FAILED'), row(2, 'FAILED')], prefix)).toBe(0);
    expect(resolveTokenGrantRetryGeneration([row(0, 'FAILED'), row(2, 'FAILED')], prefix)).toBe(1);
  });

  it('at the limit it returns null, so the caller can stop instead of retrying forever', () => {
    const all = Array.from({ length: TOKEN_GRANT_RETRY_GENERATION_LIMIT }, (_, g) => row(g, 'FAILED'));
    expect(resolveTokenGrantRetryGeneration(all, prefix)).toBeNull();
    expect(resolveTokenGrantRetryGeneration(all.slice(0, -1), prefix)).toBe(TOKEN_GRANT_RETRY_GENERATION_LIMIT - 1);
  });

  it('the key is the prefix plus the generation, and generation 0 is the default', () => {
    expect(tokenGrantIdempotencyKey('exit:p:1', 4663, TOKEN, UR, 0)).toBe(`${prefix}0`);
    expect(tokenGrantIdempotencyKey('exit:p:1', 4663, TOKEN, UR, 0, 3)).toBe(`${prefix}3`);
    expect(tokenGrantIdempotencyKey('exit:p:1', 4663, TOKEN, UR, 0).startsWith('permit2:exit:')).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Address } from 'viem';
import { classifyExitApprovalSpender } from '../../src/exits/exitApprovalSpender';
import { executeExit, type ExecuteExitDeps } from '../../src/exits/executeExit';
import { assessTokenGrant, type TokenGrantAssessment } from '../../src/exits/permit2TokenGrant';
import { config } from '../../src/config';
import { EXECUTION_TARGETS } from '../../src/config/constants';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import type { SwapExecutor, SwapQuote } from '../../src/swap/types';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { makeCreateInput } from '../positions/fixtures';

/**
 * The exit's ERC20 approval spender policy.
 *
 * The Permit2-enabled router flow consumes exactly one allowance,
 * `TOKEN -> Permit2`. Before this change the leg reused the SWAP-TARGET
 * allowlist, which refused Permit2 and accepted routers/proxies instead -- so a
 * freshly generated executor (no pre-existing allowances) could never complete
 * an exit, while the production wallet only worked because a consumer wallet app
 * had granted unlimited TOKEN -> Permit2 allowances months earlier.
 */
const PERMIT2 = getAddress(config.uniswap.v4.permit2);
const UR = getAddress(EXECUTION_TARGETS[4663]!.universalRouters[0]!);
const APPROVED_PROXY = getAddress(EXECUTION_TARGETS[4663]!.swapProxies[0]!);
const LEGACY_PROXY = getAddress('0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9');
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const U = (n: number): bigint => BigInt(n) * 10n ** 18n;
const RECEIPT_TOKEN = U(3); // what the remove-liquidity receipt proved (D8 FIX 1)
const NOW = Math.floor(Date.now() / 1000);
const TX: TxRequest = { to: UR, data: '0x3593564c', value: 0n };

describe('classifyExitApprovalSpender -- the pure policy', () => {
  const base = { configuredPermit2: PERMIT2, amountRaw: RECEIPT_TOKEN };

  it('A. the configured Permit2 is ACCEPTED, and the CONFIGURED address is what comes back', () => {
    const d = classifyExitApprovalSpender({ ...base, spender: PERMIT2 });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.spender).toBe(PERMIT2);
    // even when the provider echoes it in a different case, the decision carries
    // the configured value -- the provider's string never reaches the calldata
    const lower = classifyExitApprovalSpender({ ...base, spender: PERMIT2.toLowerCase() });
    expect(lower.ok).toBe(true);
    if (lower.ok) expect(lower.spender).toBe(PERMIT2);
  });

  it('A2. casing does not matter -- the same address in any case is accepted', () => {
    expect(classifyExitApprovalSpender({ ...base, spender: PERMIT2.toLowerCase() }).ok).toBe(true);
    expect(classifyExitApprovalSpender({ ...base, spender: PERMIT2.toUpperCase().replace('0X', '0x') as Address }).ok).toBe(true);
  });

  it('B. an unknown contract is REJECTED', () => {
    const d = classifyExitApprovalSpender({ ...base, spender: '0x1234567890123456789012345678901234567890' });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.refusal).toBe('SPENDER_NOT_PERMIT2');
      expect(d.reason).toMatch(/only ever needs an allowance for the configured/);
    }
  });

  it('C. the legacy SwapProxy is REJECTED as an approval spender', () => {
    expect(classifyExitApprovalSpender({ ...base, spender: LEGACY_PROXY }).ok).toBe(false);
  });

  it('C2. even an APPROVED SwapProxy is REJECTED as an approval spender (it is a call target, not a puller)', () => {
    const d = classifyExitApprovalSpender({ ...base, spender: APPROVED_PROXY });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal).toBe('SPENDER_NOT_PERMIT2');
  });

  it('D. the approved Universal Router is REJECTED as a TOKEN ERC20 approval spender', () => {
    const d = classifyExitApprovalSpender({ ...base, spender: UR });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal).toBe('SPENDER_NOT_PERMIT2');
  });

  it('F. a zero or negative amount is REJECTED even for Permit2', () => {
    expect(classifyExitApprovalSpender({ ...base, spender: PERMIT2, amountRaw: 0n }).ok).toBe(false);
    const d = classifyExitApprovalSpender({ ...base, spender: PERMIT2, amountRaw: -1n });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal).toBe('NON_POSITIVE_AMOUNT');
  });

  it('G. a WRONG Permit2-shaped address is REJECTED -- one hex digit off is not Permit2', () => {
    const almost = ('0x' + PERMIT2.slice(2, -1) + (PERMIT2.slice(-1) === '3' ? '4' : '3')) as Address;
    expect(almost.toLowerCase()).not.toBe(PERMIT2.toLowerCase());
    expect(classifyExitApprovalSpender({ ...base, spender: almost }).ok).toBe(false);
  });

  it('G2. a broken configuration fails CLOSED -- nothing is approved', () => {
    for (const bad of ['', '0x', 'not-an-address', '0x0000000000000000000000000000000000000000']) {
      const d = classifyExitApprovalSpender({ spender: PERMIT2, configuredPermit2: bad, amountRaw: RECEIPT_TOKEN });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.refusal).toBe('PERMIT2_NOT_CONFIGURED');
    }
  });

  it('H. the API can never override the configured Permit2: the decision compares against config alone', () => {
    // Whatever the provider says, only the configured address is accepted --
    // including an attacker-supplied "Permit2" from a different chain.
    const foreignPermit2 = '0x000000000022d473030f116ddee9f6b43ac78ba4'; // last nibble changed
    expect(classifyExitApprovalSpender({ ...base, spender: foreignPermit2 }).ok).toBe(false);
    expect(classifyExitApprovalSpender({ ...base, spender: PERMIT2 }).ok).toBe(true);
  });

  it('malformed spender values are refusals, never throws', () => {
    for (const bad of ['', '0x', '0xnothex', 'undefined', '0x12345']) {
      expect(() => classifyExitApprovalSpender({ ...base, spender: bad })).not.toThrow();
      expect(classifyExitApprovalSpender({ ...base, spender: bad }).ok).toBe(false);
    }
  });

  it('a NON-STRING spender (a provider returning null/undefined/a number) is refused, never thrown on', () => {
    // The mapper types this as a string, but the value originates in an external
    // response: if it ever arrives as something else, the policy must still
    // return a refusal rather than throw out of the exit cycle.
    for (const bad of [undefined, null, 0, 123, {}, []] as unknown[]) {
      expect(() => classifyExitApprovalSpender({ ...base, spender: bad as string })).not.toThrow();
      const d = classifyExitApprovalSpender({ ...base, spender: bad as string });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.refusal).toBe('SPENDER_NOT_PERMIT2');
    }
  });

  it('a non-bigint amount is refused, never thrown on', () => {
    for (const bad of [undefined, null, '5', 5] as unknown[]) {
      const d = classifyExitApprovalSpender({ ...base, spender: PERMIT2, amountRaw: bad as bigint });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.refusal).toBe('NON_POSITIVE_AMOUNT');
    }
  });
});

// --------------------------------------------------------------------------
// The same policy as the exit flow actually applies it.
// --------------------------------------------------------------------------
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

const grantValid = (): TokenGrantAssessment =>
  assessTokenGrant({
    readFor: { owner: WALLET, token: TOKEN, spender: UR },
    expectedOwner: WALLET,
    expectedToken: TOKEN,
    spender: UR,
    targets: { chainId: 4663, universalRouters: [UR], swapProxies: [] },
    grant: { amount: 2n ** 159n, expiration: NOW + 86_400, nonce: 0 },
    requiredAmount: 1n,
    chainTimestamp: NOW,
  });

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
  const remove = await txAttempts.create(`${position.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
  await txAttempts.update(remove.id, { status: 'VERIFIED', txHash: `0x${'ee'.repeat(32)}`, verifyData: { liquidityZero: true, usdgProceedsRaw: U(400), tokenProceedsRaw: receiptTokenRaw } });
  return { positions, exitStates, txAttempts, position };
}
type Ctx = Awaited<ReturnType<typeof scenario>>;

/** `tokenAllowanceRaw` is the wallet's CURRENT TOKEN->spender ERC20 allowance. */
interface HarnessOptions {
  spender: Address | null;
  needsApproval: boolean;
  tokenAllowanceRaw?: bigint;
  /** The receipt-proven TOKEN amount this exit sells (D8 FIX 1). */
  receiptTokenRaw?: bigint;
  /** Wallet TOKEN balance -- only ever a floor check. */
  walletTokenRaw?: bigint;
  /** The on-chain allowance read fails. */
  allowanceThrows?: boolean;
  /** The provider's advisory check_approval call fails. */
  checkApprovalThrows?: boolean;
}

function harness(ctx: Ctx, o: HarnessOptions) {
  const receipt = o.receiptTokenRaw ?? RECEIPT_TOKEN;
  const approveCalls: { token: Address; spender: Address; amount: bigint }[] = [];
  const quotedAmounts: bigint[] = [];
  const quote = (amountInRaw: bigint): SwapQuote => ({
    amountInRaw, expectedAmountOutRaw: U(2), minOutputAmountRaw: U(1), priceImpactPct: 0.001, slippageBps: 100, providerQuote: {}, permitDataPresent: true,
  });
  const swapExecutor: SwapExecutor = {
    getQuote: vi.fn(async (_t: Address, amountInRaw: bigint) => { quotedAmounts.push(amountInRaw); return quote(amountInRaw); }),
    checkApproval: vi.fn(async () => {
      if (o.checkApprovalThrows) throw new Error('check_approval unavailable');
      return { needsApproval: o.needsApproval, spender: o.spender };
    }),
    buildSwapTx: vi.fn(),
  };
  const buildApproveDeps = vi.fn((token: Address, spender: Address, amount: bigint) => {
    approveCalls.push({ token, spender, amount });
    return fakeTxDeps({ allowanceRaw: amount });
  });
  const warnLog = vi.fn();
  const swapSign = vi.fn(async () => ({ raw: '0x02' as `0x${string}`, hash: `0x${'22'.repeat(32)}` as `0x${string}` }));
  const tokenGrantPreflight = vi.fn(async () => grantValid());
  const deps: ExecuteExitDeps = {
    positions: ctx.positions, exitStates: ctx.exitStates, txAttempts: ctx.txAttempts,
    livePositionState: { getLiveState: vi.fn() }, poolPrice: { getPriceState: vi.fn() },
    swapExecutor,
    readTokenBalance: vi.fn(async () => o.walletTokenRaw ?? receipt),
    readAllowance: vi.fn(async () => {
      if (o.allowanceThrows) throw new Error('RPC down: allowance unreadable');
      return o.tokenAllowanceRaw ?? 0n;
    }),
    walletAddress: WALLET,
    tokenGrantPreflight,
    buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps({ liquidityZero: true as const, usdgProceedsRaw: U(400), tokenProceedsRaw: receipt } as never)),
    buildSwapDeps: vi.fn(() => fakeTxDeps({ usdgIncreaseRaw: U(2), usdgProceedsRaw: U(2) }, { signTransaction: swapSign })) as never,
    buildApproveDeps: buildApproveDeps as never,
    warnLog,
  };
  return { deps, approveCalls, quotedAmounts, buildApproveDeps, swapExecutor, warnLog, swapSign, tokenGrantPreflight };
}

describe('HIGH-1: the ON-CHAIN allowance decides, the provider is advisory only', () => {
  it('A. allowance 0 and the API says needsApproval=false -> the approval STILL happens', async () => {
    // The invariant that matters regardless of any particular token's behaviour:
    // a remote `false` can never suppress an approval the chain requires. (On
    // chain 4663 the two live tokens differ -- MEME grants Permit2 an infinite
    // allowance in its own contract, PONS starts at 0 -- which is exactly why
    // the decision must be read locally rather than asked for.)
    const ctx = await scenario();
    const h = harness(ctx, { spender: null, needsApproval: false, tokenAllowanceRaw: 0n });

    const out = await executeExit(ctx.position, h.deps);

    expect(out).toEqual({ outcome: 'CLOSED' });
    expect(h.approveCalls).toEqual([{ token: TOKEN, spender: PERMIT2, amount: RECEIPT_TOKEN }]);
    const row = await ctx.txAttempts.find(`${ctx.position.closeIdempotencyKey}:approve:0`);
    expect(row?.status).toBe('VERIFIED');
    // the disagreement is recorded for telemetry, never acted on
    expect(h.warnLog).toHaveBeenCalledWith('exit_approval_provider_disagrees', expect.objectContaining({ providerNeedsApproval: false, onChainAllowanceRaw: '0' }));
  });

  it('B. allowance BELOW the receipt amount and the API says false -> the approval still happens', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { spender: null, needsApproval: false, tokenAllowanceRaw: RECEIPT_TOKEN - 1n });
    expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');
    expect(h.approveCalls).toEqual([{ token: TOKEN, spender: PERMIT2, amount: RECEIPT_TOKEN }]);
  });

  it('C. allowance SUFFICIENT and the API says true -> NO approval is sent', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { spender: PERMIT2, needsApproval: true, tokenAllowanceRaw: RECEIPT_TOKEN });
    expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');
    expect(h.buildApproveDeps).not.toHaveBeenCalled();
    expect(await ctx.txAttempts.find(`${ctx.position.closeIdempotencyKey}:approve:0`)).toBeNull();
  });

  it('D. allowance SUFFICIENT and the API says false -> NO approval is sent', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { spender: null, needsApproval: false, tokenAllowanceRaw: RECEIPT_TOKEN * 2n });
    expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');
    expect(h.buildApproveDeps).not.toHaveBeenCalled();
  });

  it('E. a MALICIOUS provider spender cannot redirect the allowance -- the configured Permit2 is used', async () => {
    for (const rogue of [UR, APPROVED_PROXY, LEGACY_PROXY, '0x1234567890123456789012345678901234567890' as Address]) {
      const ctx = await scenario();
      const h = harness(ctx, { spender: rogue, needsApproval: true, tokenAllowanceRaw: 0n });
      expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');
      expect(h.approveCalls).toEqual([{ token: TOKEN, spender: PERMIT2, amount: RECEIPT_TOKEN }]);
      expect(h.approveCalls.map((c) => c.spender.toLowerCase())).not.toContain(rogue.toLowerCase());
      expect(h.warnLog).toHaveBeenCalledWith('exit_approval_provider_disagrees', expect.objectContaining({ providerSpender: rogue }));
    }
  });

  it('F. the comparison uses the EXACT receipt amount, at the boundary in both directions', async () => {
    // allowance == receipt -> skip; allowance == receipt-1 -> approve
    const exact = await scenario(RECEIPT_TOKEN);
    const hExact = harness(exact, { spender: null, needsApproval: false, tokenAllowanceRaw: RECEIPT_TOKEN });
    expect((await executeExit(exact.position, hExact.deps)).outcome).toBe('CLOSED');
    expect(hExact.buildApproveDeps).not.toHaveBeenCalled();

    // a DIFFERENT receipt amount moves the boundary with it
    const bigger = await scenario(RECEIPT_TOKEN * 10n);
    const hBigger = harness(bigger, { spender: null, needsApproval: false, tokenAllowanceRaw: RECEIPT_TOKEN, receiptTokenRaw: RECEIPT_TOKEN * 10n });
    expect((await executeExit(bigger.position, hBigger.deps)).outcome).toBe('CLOSED');
    expect(hBigger.approveCalls).toEqual([{ token: TOKEN, spender: PERMIT2, amount: RECEIPT_TOKEN * 10n }]);
    expect(hBigger.deps.readAllowance).toHaveBeenCalledWith(TOKEN, WALLET, PERMIT2);
  });

  it('G. a wallet balance far LARGER than the receipt amount does not widen the approval', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { spender: null, needsApproval: false, tokenAllowanceRaw: 0n, walletTokenRaw: RECEIPT_TOKEN * 1000n });
    expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');
    expect(h.approveCalls).toEqual([{ token: TOKEN, spender: PERMIT2, amount: RECEIPT_TOKEN }]);
    expect(h.quotedAmounts).toEqual([RECEIPT_TOKEN]);
  });

  it('G2. the allowance is compared against the RECEIPT amount, not the wallet balance', async () => {
    // allowance sits BETWEEN the receipt amount and the (much larger) wallet
    // balance: comparing against the balance would approve needlessly, and would
    // re-approve on every tick for as long as the wallet held unrelated TOKEN.
    const ctx = await scenario();
    const h = harness(ctx, {
      spender: null,
      needsApproval: false,
      tokenAllowanceRaw: RECEIPT_TOKEN + 1n,
      walletTokenRaw: RECEIPT_TOKEN * 1000n,
    });

    expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');

    expect(h.buildApproveDeps).not.toHaveBeenCalled();
    expect(await ctx.txAttempts.find(`${ctx.position.closeIdempotencyKey}:approve:0`)).toBeNull();
  });

  it('H. an allowance READ FAILURE fails closed: no approval, no grant, no swap', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { spender: null, needsApproval: false, tokenAllowanceRaw: 0n, allowanceThrows: true });

    const out = await executeExit(ctx.position, h.deps);

    expect(out.outcome).toBe('PENDING');
    if (out.outcome === 'PENDING') expect(out.reason).toMatch(/could not read the TOKEN allowance to Permit2/);
    expect(h.buildApproveDeps).not.toHaveBeenCalled();
    expect(h.tokenGrantPreflight).not.toHaveBeenCalled();
    expect(h.swapSign).not.toHaveBeenCalled();
    expect((await ctx.positions.findById(ctx.position.id))?.status).toBe('CLOSING');
  });

  it('I. a provider that THROWS on check_approval cannot stop the approval the chain requires', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { spender: null, needsApproval: false, tokenAllowanceRaw: 0n, checkApprovalThrows: true });
    expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');
    expect(h.approveCalls).toEqual([{ token: TOKEN, spender: PERMIT2, amount: RECEIPT_TOKEN }]);
    expect(h.warnLog).toHaveBeenCalledWith('exit_approval_provider_unavailable', expect.objectContaining({ positionId: ctx.position.id }));
  });

  it('J. two concurrent exits produce exactly ONE approval transaction', async () => {
    const ctx = await scenario();
    const a = harness(ctx, { spender: null, needsApproval: false, tokenAllowanceRaw: 0n });
    const b = harness(ctx, { spender: null, needsApproval: false, tokenAllowanceRaw: 0n });

    const [ra, rb] = await Promise.all([executeExit(ctx.position, a.deps), executeExit(ctx.position, b.deps)]);

    expect(a.approveCalls.length + b.approveCalls.length).toBe(1);
    const rows = await ctx.txAttempts.findByKeyPrefixes([`${ctx.position.closeIdempotencyKey}:approve:`]);
    expect(rows).toHaveLength(1);
    expect([ra.outcome, rb.outcome].filter((o) => o === 'PENDING')).toHaveLength(1);
  });

  it('no approval is attempted when the exit has nothing to sell (USDG-only close)', async () => {
    const ctx = await scenario(0n);
    const h = harness(ctx, { spender: null, needsApproval: false, tokenAllowanceRaw: 0n, receiptTokenRaw: 0n });
    const out = await executeExit(ctx.position, h.deps);
    expect(out.outcome).not.toBe('SWAP_FAILED_RETRY_PENDING');
    expect(h.buildApproveDeps).not.toHaveBeenCalled();
  });

  it('the approval is built from the CONFIGURED Permit2, not the provider echo (lowercase in -> configured value out)', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { spender: PERMIT2.toLowerCase() as Address, needsApproval: true, tokenAllowanceRaw: 0n });
    expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');
    expect(h.approveCalls).toEqual([{ token: TOKEN, spender: PERMIT2, amount: RECEIPT_TOKEN }]);
    expect(h.deps.readAllowance).toHaveBeenCalledWith(TOKEN, WALLET, PERMIT2);
  });

  it('an insufficient allowance tops up to exactly the receipt amount, never more', async () => {
    const ctx = await scenario();
    const h = harness(ctx, { spender: PERMIT2, needsApproval: true, tokenAllowanceRaw: RECEIPT_TOKEN - 1n });
    expect((await executeExit(ctx.position, h.deps)).outcome).toBe('CLOSED');
    expect(h.approveCalls).toEqual([{ token: TOKEN, spender: PERMIT2, amount: RECEIPT_TOKEN }]);
    expect(h.approveCalls[0]!.amount).not.toBe(2n ** 256n - 1n);
  });
});

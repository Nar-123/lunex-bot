import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import request from 'supertest';
import { executeExit } from '../../src/exits/executeExit';
import type { ExecuteExitDeps } from '../../src/exits/executeExit';
import { settleResidualTokenViaReceipt } from '../../src/exits/manualTokenSettlement';
import type { ManualSettlementChainReader, ManualSettlementResult } from '../../src/exits/manualTokenSettlement';
import { assessClosingRecovery } from '../../src/exits/closingRecovery';
import { exitLegKeyPrefix } from '../../src/capital/freshCapitalSnapshot';
import { PositionCapitalSnapshotProvider } from '../../src/positions/capitalSnapshotProvider';
import { EMPTY_EXIT_STATE } from '../../src/exits/types';
import type { TxRequest, TxSafetyDeps } from '../../src/execution/types';
import type { SwapExecutor } from '../../src/swap/types';
import type { RemoveLiquidityVerifyData } from '../../src/exits/removeLiquidityTx';
import { config } from '../../src/config';
import { signAccessToken } from '../../src/auth/jwt';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { makeCreateInput } from '../positions/fixtures';
import { buildTestApp, authHeader } from '../api/testApp';
import { REMOVE_HASH, SETTLE_HASH, approvalLog, chainWithSettlement, fakeChain, nftTransferLog, swapLogs, transferLog, withdrawalLog } from './settlementFixtures';

// Manual TOKEN settlement via receipt: an operator-supplied transaction
// settles a CLOSING position's receipt-proven residual TOKEN ONLY when its
// own receipt proves it (see src/exits/manualTokenSettlement.ts). Every
// unsafe case must fail closed: CLOSING, no proceeds, no cooldown, no
// settlement row.

const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const OTHER = '0x0000000000000000000000000000000000000077' as Address;
const FAKE_USDG = '0x00000000000000000000000000000000000000fe' as Address;
const USDG_ADDR = config.quoteAsset.ADDRESS as Address;
const CHAIN = config.chain.chainId;
const U = (n: number): bigint => BigInt(n) * 10n ** 18n;
const RESIDUAL = U(3);
const TX: TxRequest = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0n };
const S = { wallet: WALLET, token: TOKEN, usdg: USDG_ADDR, chainId: CHAIN };

function fakeTxDeps<T>(data: T): TxSafetyDeps<T> {
  return {
    buildTransaction: vi.fn(async () => TX),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 7),
    signTransaction: vi.fn(async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: REMOVE_HASH as `0x${string}` })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 100n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data })),
  };
}
const noQuote = (): SwapExecutor => ({ getQuote: vi.fn(async () => { throw new Error('HTTP 404 No quotes available'); }), checkApproval: vi.fn(), buildSwapTx: vi.fn() });

/** A CLOSING position genuinely stuck on an unroutable TOKEN leg, reached through the REAL executeExit. */
async function stuckPosition(o: { token?: Address; removeData?: object } = {}) {
  const cooldown = { recordExit: vi.fn(async (_t: string, _at?: Date) => undefined) };
  const txAttempts = new InMemoryTransactionAttemptRepository();
  const positions = new InMemoryPositionRepository(txAttempts, cooldown);
  const exitStates = new InMemoryExitStateRepository();
  const token = o.token ?? TOKEN;
  const created = await positions.create(makeCreateInput({ tokenAddress: token, entryUsdgRaw: U(500) }));
  await positions.markActive(created.id, '1', new Date());
  const closing = (await positions.markClosing(created.id, `exit:${created.id}:1`))!;
  exitStates.seed({ positionId: created.id, ...EMPTY_EXIT_STATE, pendingCloseReason: 'HARD_STOP_LOSS' });
  const exitDeps: ExecuteExitDeps = {
    positions,
    exitStates,
    txAttempts,
    livePositionState: { getLiveState: vi.fn() },
    poolPrice: { getPriceState: vi.fn() },
    swapExecutor: noQuote(),
    buildRemoveLiquidityDeps: vi.fn(() => fakeTxDeps((o.removeData ?? { liquidityZero: true as const, usdgProceedsRaw: U(200), tokenProceedsRaw: RESIDUAL }) as RemoveLiquidityVerifyData)),
    readTokenBalance: vi.fn(async () => RESIDUAL),
    walletAddress: WALLET,
    warnLog: vi.fn(),
  };
  expect((await executeExit(closing, exitDeps)).outcome).toBe('PENDING');
  const settle = (chain: ManualSettlementChainReader, txHash: string = SETTLE_HASH, key = closing.closeIdempotencyKey!) =>
    settleResidualTokenViaReceipt({ positions, txAttempts, exitStates, chain, walletAddress: WALLET }, { positionId: created.id, txHash, closeIdempotencyKey: key });
  return { cooldown, positions, txAttempts, exitStates, id: created.id, closing, settle, exitDeps };
}

type Ctx = Awaited<ReturnType<typeof stuckPosition>>;

async function expectUntouched(ctx: Ctx) {
  expect(await ctx.positions.findById(ctx.id)).toMatchObject({ status: 'CLOSING', realizedUsdgRaw: null, closedAt: null });
  expect(ctx.cooldown.recordExit).not.toHaveBeenCalled();
  expect(ctx.positions.manualSettlements.size).toBe(0);
}

async function expectRejected(ctx: Ctx, result: ManualSettlementResult, reason: string) {
  expect(result).toMatchObject({ outcome: 'REJECTED', reason });
  await expectUntouched(ctx);
}

describe('Manual TOKEN settlement via receipt -- success, PnL, H2, cooldown, stuck view', () => {
  it('a receipt proving TOKEN out (>= residual) and USDG in settles THIS position through markClosed: CLOSED, realized = remove USDG + receipt USDG, cooldown once at closedAt, slot released, deployed 0, gone from stuck view', async () => {
    const ctx = await stuckPosition();
    // Before: CLOSING, TOKEN residual counted at cost, USDG returned counted once (in the wallet).
    const before = await new PositionCapitalSnapshotProvider(ctx.positions, WALLET, async () => U(700), ctx.txAttempts).getSnapshot();
    expect(before).toEqual({ freeUsdgBalance: U(700), totalDeployedUsdg: U(300), activePositionsCount: 1 });

    const r = await ctx.settle(chainWithSettlement(S, swapLogs(S, RESIDUAL, U(290))));
    expect(r).toMatchObject({ outcome: 'SETTLED', tokenDisposedRaw: RESIDUAL, usdgProceedsRaw: U(290), realizedUsdgRaw: U(490) });

    const row = (await ctx.positions.findById(ctx.id))!;
    expect(row).toMatchObject({ status: 'CLOSED', realizedUsdgRaw: U(200) + U(290), closeReason: 'HARD_STOP_LOSS' });
    expect(ctx.cooldown.recordExit).toHaveBeenCalledTimes(1);
    expect(ctx.cooldown.recordExit).toHaveBeenCalledWith(TOKEN, row.closedAt);
    expect(await ctx.positions.findManualSettlementByTxHash(SETTLE_HASH)).toMatchObject({ positionId: ctx.id, tokenDisposedRaw: RESIDUAL, usdgProceedsRaw: U(290), blockNumber: 120n });

    // After: the swap's USDG is now in the wallet (990); nothing deployed, slot free, no double count.
    const after = await new PositionCapitalSnapshotProvider(ctx.positions, WALLET, async () => U(990), ctx.txAttempts).getSnapshot();
    expect(after).toEqual({ freeUsdgBalance: U(990), totalDeployedUsdg: 0n, activePositionsCount: 0 });
    expect(await ctx.positions.countNonClosed()).toBe(0);
    expect((await ctx.positions.findAllClosing()).map((p) => p.id)).not.toContain(ctx.id);
  });

  it('TOKEN disposed beyond the residual is accepted (same attribution as the bot\'s own balance-wide exit swap); third-party router/pool hops are ignored', async () => {
    const ctx = await stuckPosition();
    expect(await ctx.settle(chainWithSettlement(S, swapLogs(S, RESIDUAL + 5n, U(291))))).toMatchObject({ outcome: 'SETTLED', tokenDisposedRaw: RESIDUAL + 5n, usdgProceedsRaw: U(291) });
  });

  it('several USDG transfers INTO the wallet in the same receipt are summed (existing aggregation semantics)', async () => {
    const ctx = await stuckPosition();
    const logs = [transferLog(TOKEN, WALLET, OTHER, RESIDUAL, 0), transferLog(USDG_ADDR, OTHER, WALLET, U(100), 1), transferLog(USDG_ADDR, OTHER, WALLET, U(190), 2)];
    expect(await ctx.settle(chainWithSettlement(S, logs))).toMatchObject({ outcome: 'SETTLED', usdgProceedsRaw: U(290) });
  });

  it('the stuck view shows the close lifecycle key needed for the request while stuck; the settled position leaves it', async () => {
    const ctx = await stuckPosition();
    const report = assessClosingRecovery((await ctx.positions.findById(ctx.id))!, await ctx.txAttempts.findByKeyPrefixes([exitLegKeyPrefix(ctx.closing.closeIdempotencyKey!)]), await ctx.exitStates.getOrCreate(ctx.id), new Date());
    expect(report).toMatchObject({ closeIdempotencyKey: ctx.closing.closeIdempotencyKey, tokenResidualRaw: RESIDUAL, usdgRecoveredRaw: U(200) });
    await ctx.settle(chainWithSettlement(S, swapLogs(S, RESIDUAL, U(290))));
    expect(await ctx.positions.findAllClosing()).toEqual([]);
  });
});

describe('Manual TOKEN settlement via receipt -- idempotency, concurrency, crash', () => {
  it('duplicate submission of the same txHash returns the existing final state: no second close, proceeds unchanged, cooldown not moved', async () => {
    const ctx = await stuckPosition();
    const chain = chainWithSettlement(S, swapLogs(S, RESIDUAL, U(290)));
    const first = await ctx.settle(chain);
    const closedAt = (await ctx.positions.findById(ctx.id))!.closedAt;
    const again = await ctx.settle(chain);
    expect(first.outcome).toBe('SETTLED');
    expect(again).toMatchObject({ outcome: 'ALREADY_SETTLED', realizedUsdgRaw: U(490), usdgProceedsRaw: U(290) });
    expect((await ctx.positions.findById(ctx.id))!).toMatchObject({ realizedUsdgRaw: U(490), closedAt });
    expect(ctx.cooldown.recordExit).toHaveBeenCalledTimes(1);
    expect(ctx.positions.manualSettlements.size).toBe(1);
  });

  it('two operators submit the same txHash simultaneously: exactly one finalization; the loser writes nothing', async () => {
    const ctx = await stuckPosition();
    const chain = chainWithSettlement(S, swapLogs(S, RESIDUAL, U(290)));
    const results = await Promise.all([ctx.settle(chain), ctx.settle(chain)]);
    expect(results.filter((r) => r.outcome === 'SETTLED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome !== 'SETTLED').every((r) => r.outcome === 'ALREADY_SETTLED' || (r.outcome === 'REJECTED' && r.reason === 'POSITION_BUSY'))).toBe(true);
    expect(ctx.cooldown.recordExit).toHaveBeenCalledTimes(1);
    expect((await ctx.positions.findById(ctx.id))?.realizedUsdgRaw).toBe(U(490));
  });

  it('two settlements racing past the claim (claim expired): markClosed\'s CLOSING+close-key condition still lets exactly one win', async () => {
    const ctx = await stuckPosition();
    vi.spyOn(ctx.positions, 'claimForResume').mockImplementation(async () => `forced-${Math.random()}`);
    const chain = chainWithSettlement(S, swapLogs(S, RESIDUAL, U(290)));
    const results = await Promise.all([ctx.settle(chain), ctx.settle(chain)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['ALREADY_SETTLED', 'SETTLED']);
    expect(ctx.cooldown.recordExit).toHaveBeenCalledTimes(1);
  });

  it('crash during finalization (cooldown write fails) rolls back: CLOSING, no proceeds, no settlement row; resubmitting the same txHash finalizes exactly once, with no broadcast of anything', async () => {
    const ctx = await stuckPosition();
    ctx.cooldown.recordExit.mockRejectedValueOnce(new Error('process killed during finalization'));
    const chain = chainWithSettlement(S, swapLogs(S, RESIDUAL, U(290)));
    await expect(ctx.settle(chain)).rejects.toThrow(/process killed/);
    expect(await ctx.positions.findById(ctx.id)).toMatchObject({ status: 'CLOSING', realizedUsdgRaw: null });
    expect(ctx.positions.manualSettlements.size).toBe(0);
    expect(await ctx.settle(chain)).toMatchObject({ outcome: 'SETTLED', realizedUsdgRaw: U(490) });
    expect(ctx.positions.manualSettlements.size).toBe(1);
    expect((await ctx.positions.findById(ctx.id))?.status).toBe('CLOSED');
  });

  it('a transaction already used to settle another position is rejected (TX_ALREADY_USED)', async () => {
    const a = await stuckPosition();
    await a.settle(chainWithSettlement(S, swapLogs(S, RESIDUAL, U(290))));
    // Position B shares the repository -- simulate by recording the same hash for a second position.
    const b = await stuckPosition({ token: OTHER });
    b.positions.manualSettlements.set(SETTLE_HASH, { ...(await a.positions.findManualSettlementByTxHash(SETTLE_HASH))!, positionId: 'some-other-position' });
    const r = await b.settle(chainWithSettlement({ ...S, token: OTHER }, swapLogs({ ...S, token: OTHER }, RESIDUAL, U(290))));
    expect(r).toMatchObject({ outcome: 'REJECTED', reason: 'TX_ALREADY_USED' });
    expect(await b.positions.findById(b.id)).toMatchObject({ status: 'CLOSING', realizedUsdgRaw: null });
  });
});

describe('Manual TOKEN settlement via receipt -- replay / wrong transaction (all fail closed)', () => {
  const cases: Array<[string, (s: typeof S) => ManualSettlementChainReader, string]> = [
    ['nonexistent txHash', () => fakeChain(CHAIN, {}), 'TX_NOT_FOUND'],
    ['pending / not mined', (s) => chainWithSettlement(s, swapLogs(s, RESIDUAL, U(290)), { pending: true }), 'TX_PENDING'],
    ['reverted receipt', (s) => chainWithSettlement(s, swapLogs(s, RESIDUAL, U(290)), { status: 'reverted' }), 'TX_REVERTED'],
    ['wrong chain (tx signed for another chain)', (s) => chainWithSettlement(s, swapLogs(s, RESIDUAL, U(290)), { chainId: CHAIN + 1 }), 'WRONG_CHAIN'],
    ['wrong chain (tx without chain id)', (s) => chainWithSettlement(s, swapLogs(s, RESIDUAL, U(290)), { chainId: null }), 'WRONG_CHAIN'],
    ['wrong chain (RPC serves another chain)', (s) => chainWithSettlement(s, swapLogs(s, RESIDUAL, U(290)), { rpcChainId: CHAIN + 1 }), 'WRONG_CHAIN'],
    ['transaction from another wallet', (s) => chainWithSettlement(s, swapLogs(s, RESIDUAL, U(290)), { from: OTHER }), 'NOT_FROM_BOT_WALLET'],
    ['transaction before this lifecycle\'s remove (earlier block)', (s) => chainWithSettlement(s, swapLogs(s, RESIDUAL, U(290)), { at: { blockNumber: 99n, transactionIndex: 9 } }), 'TX_NOT_AFTER_REMOVE_LIQUIDITY'],
    ['transaction before the remove in the same block', (s) => chainWithSettlement(s, swapLogs(s, RESIDUAL, U(290)), { at: { blockNumber: 100n, transactionIndex: 4 } }), 'TX_NOT_AFTER_REMOVE_LIQUIDITY'],
    ['native value spent in the same tx', (s) => chainWithSettlement(s, swapLogs(s, RESIDUAL, U(290)), { value: 1n }), 'UNABLE_TO_BIND_TRANSACTION_TO_POSITION'],
    ['wrong TOKEN disposed', (s) => chainWithSettlement(s, swapLogs({ ...s, token: OTHER }, RESIDUAL, U(290))), 'NO_TOKEN_DISPOSAL'],
    ['wrong USDG contract paid the wallet', (s) => chainWithSettlement(s, swapLogs({ ...s, usdg: FAKE_USDG }, RESIDUAL, U(290))), 'NO_USDG_RECEIVED'],
    ['TOKEN transfer in the wrong direction', (s) => chainWithSettlement(s, [transferLog(TOKEN, OTHER, WALLET, RESIDUAL, 0), transferLog(USDG_ADDR, OTHER, WALLET, U(290), 1)]), 'TOKEN_WRONG_DIRECTION'],
    ['USDG transfer in the wrong direction', (s) => chainWithSettlement(s, [transferLog(TOKEN, WALLET, OTHER, RESIDUAL, 0), transferLog(USDG_ADDR, WALLET, OTHER, U(290), 1)]), 'USDG_WRONG_DIRECTION'],
    ['insufficient TOKEN disposed (partial)', (s) => chainWithSettlement(s, swapLogs(s, RESIDUAL - 1n, U(290))), 'INSUFFICIENT_TOKEN_DISPOSED'],
    ['no USDG at all (TOKEN given away)', (s) => chainWithSettlement(s, [transferLog(TOKEN, WALLET, OTHER, RESIDUAL, 0)]), 'NO_USDG_RECEIVED'],
    ['unrelated USDG: wallet also SENDS USDG in the tx', (s) => chainWithSettlement(s, [...swapLogs(s, RESIDUAL, U(290)), transferLog(USDG_ADDR, WALLET, OTHER, U(1), 9)]), 'UNABLE_TO_BIND_TRANSACTION_TO_POSITION'],
    ['unrelated USDG: another asset of the wallet also sold in the tx', (s) => chainWithSettlement(s, [...swapLogs(s, RESIDUAL, U(290)), transferLog(OTHER, WALLET, OTHER, U(9), 9)]), 'UNABLE_TO_BIND_TRANSACTION_TO_POSITION'],
    ['unrelated TOKEN: two separate TOKEN transfers out of the wallet', (s) => chainWithSettlement(s, [...swapLogs(s, RESIDUAL, U(290)), transferLog(TOKEN, WALLET, OTHER, 1n, 9)]), 'UNABLE_TO_BIND_TRANSACTION_TO_POSITION'],
    ['unrelated TOKEN: TOKEN also flows INTO the wallet', (s) => chainWithSettlement(s, [...swapLogs(s, RESIDUAL, U(290)), transferLog(TOKEN, OTHER, WALLET, 1n, 9)]), 'UNABLE_TO_BIND_TRANSACTION_TO_POSITION'],
    ['wallet also unwraps WETH in the tx', (s) => chainWithSettlement(s, [...swapLogs(s, RESIDUAL, U(290)), withdrawalLog(OTHER, WALLET, 9)]), 'UNABLE_TO_BIND_TRANSACTION_TO_POSITION'],
    ['wallet also moves an NFT in the tx', (s) => chainWithSettlement(s, [...swapLogs(s, RESIDUAL, U(290)), nftTransferLog(OTHER, WALLET, OTHER, 7n, 9)]), 'UNABLE_TO_BIND_TRANSACTION_TO_POSITION'],
  ];

  it.each(cases)('%s -> rejected, nothing written', async (_name, chainFor, reason) => {
    const ctx = await stuckPosition();
    await expectRejected(ctx, await ctx.settle(chainFor(S)), reason);
  });

  it('the remove-liquidity transaction itself is not a settlement', async () => {
    const ctx = await stuckPosition();
    await expectRejected(ctx, await ctx.settle(chainWithSettlement(S, []), REMOVE_HASH), 'TX_NOT_AFTER_REMOVE_LIQUIDITY');
  });

  it('wallet TOKEN balance being zero is never proof: a receipt without a TOKEN disposal is rejected however empty the wallet is', async () => {
    const ctx = await stuckPosition();
    ctx.exitDeps.readTokenBalance = vi.fn(async () => 0n);
    await expectRejected(ctx, await ctx.settle(chainWithSettlement(S, [approvalLog(TOKEN, WALLET, OTHER, 0), transferLog(USDG_ADDR, OTHER, WALLET, U(290), 1)])), 'NO_TOKEN_DISPOSAL');
  });

  it('partial disposal leaves the position CLOSING with the FULL residual still reported; a later full disposal settles it', async () => {
    const ctx = await stuckPosition();
    await expectRejected(ctx, await ctx.settle(chainWithSettlement(S, swapLogs(S, RESIDUAL / 2n, U(145)))), 'INSUFFICIENT_TOKEN_DISPOSED');
    const report = assessClosingRecovery((await ctx.positions.findById(ctx.id))!, await ctx.txAttempts.findByKeyPrefixes([exitLegKeyPrefix(ctx.closing.closeIdempotencyKey!)]), await ctx.exitStates.getOrCreate(ctx.id), new Date());
    expect(report.tokenResidualRaw).toBe(RESIDUAL);
    expect((await ctx.settle(chainWithSettlement(S, swapLogs(S, RESIDUAL, U(290))))).outcome).toBe('SETTLED');
  });

  it('invalid tx hash -> INVALID_REQUEST', async () => {
    const ctx = await stuckPosition();
    await expectRejected(ctx, await ctx.settle(chainWithSettlement(S, []), '0x1234'), 'INVALID_REQUEST');
  });
});

describe('Manual TOKEN settlement via receipt -- position eligibility', () => {
  const good = () => chainWithSettlement(S, swapLogs(S, RESIDUAL, U(290)));

  it.each(['OPENING', 'ACTIVE', 'FAILED'] as const)('%s position -> POSITION_NOT_CLOSING', async (status) => {
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const positions = new InMemoryPositionRepository(txAttempts);
    const p = await positions.create(makeCreateInput({ tokenAddress: TOKEN }));
    if (status === 'ACTIVE') await positions.markActive(p.id, '1', new Date());
    if (status === 'FAILED') await positions.markFailed(p.id);
    const r = await settleResidualTokenViaReceipt({ positions, txAttempts, exitStates: new InMemoryExitStateRepository(), chain: good(), walletAddress: WALLET }, { positionId: p.id, txHash: SETTLE_HASH, closeIdempotencyKey: `exit:${p.id}:1` });
    expect(r).toMatchObject({ outcome: 'REJECTED', reason: 'POSITION_NOT_CLOSING' });
    expect((await positions.findById(p.id))?.status).toBe(status);
  });

  it('a CLOSED position (closed normally, never manually settled) -> POSITION_NOT_CLOSING, untouched', async () => {
    const ctx = await stuckPosition();
    await ctx.positions.markClosed(ctx.id, new Date(), 'HARD_STOP_LOSS', 1n, ctx.closing.closeIdempotencyKey!);
    ctx.cooldown.recordExit.mockClear();
    expect(await ctx.settle(good())).toMatchObject({ outcome: 'REJECTED', reason: 'POSITION_NOT_CLOSING' });
    expect((await ctx.positions.findById(ctx.id))?.realizedUsdgRaw).toBe(1n);
    expect(ctx.cooldown.recordExit).not.toHaveBeenCalled();
  });

  it('unknown position -> POSITION_NOT_FOUND', async () => {
    const ctx = await stuckPosition();
    const r = await settleResidualTokenViaReceipt({ positions: ctx.positions, txAttempts: ctx.txAttempts, exitStates: ctx.exitStates, chain: good(), walletAddress: WALLET }, { positionId: 'nope', txHash: SETTLE_HASH, closeIdempotencyKey: 'exit:nope:1' });
    expect(r).toMatchObject({ outcome: 'REJECTED', reason: 'POSITION_NOT_FOUND' });
  });

  it('a request naming an old close lifecycle cannot finalize the newer one (STALE_CLOSE_LIFECYCLE)', async () => {
    const ctx = await stuckPosition();
    await expectRejected(ctx, await ctx.settle(good(), SETTLE_HASH, `exit:${ctx.id}:0`), 'STALE_CLOSE_LIFECYCLE');
  });

  it('a lifecycle that moves on between the check and the write is not closed (markClosed close-key guard)', async () => {
    const ctx = await stuckPosition();
    const real = ctx.exitStates.getOrCreate.bind(ctx.exitStates);
    vi.spyOn(ctx.exitStates, 'getOrCreate').mockImplementation(async (id) => {
      const row = (await ctx.positions.findById(id))!;
      row.closeIdempotencyKey = `exit:${id}:2`; // a newer lifecycle took over mid-request
      return real(id);
    });
    expect(await ctx.settle(good())).toMatchObject({ outcome: 'REJECTED', reason: 'POSITION_NOT_CLOSING' });
    expect(ctx.cooldown.recordExit).not.toHaveBeenCalled();
    expect(ctx.positions.manualSettlements.size).toBe(0);
  });

  it('while another worker holds the position -> POSITION_BUSY', async () => {
    const ctx = await stuckPosition();
    await ctx.positions.claimForResume(ctx.id, 'CLOSING', config.rules.execution.RESUME_CLAIM_FRESHNESS_MS);
    await expectRejected(ctx, await ctx.settle(good()), 'POSITION_BUSY');
  });

  it('remove-liquidity not verified (ambiguous broadcast) -> REMOVE_NOT_VERIFIED', async () => {
    const cooldown = { recordExit: vi.fn(async () => undefined) };
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const positions = new InMemoryPositionRepository(txAttempts, cooldown);
    const p = await positions.create(makeCreateInput({ tokenAddress: TOKEN }));
    await positions.markActive(p.id, '1', new Date());
    const c = (await positions.markClosing(p.id, `exit:${p.id}:1`))!;
    await txAttempts.create(`${c.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
    const r = await settleResidualTokenViaReceipt({ positions, txAttempts, exitStates: new InMemoryExitStateRepository(), chain: good(), walletAddress: WALLET }, { positionId: p.id, txHash: SETTLE_HASH, closeIdempotencyKey: c.closeIdempotencyKey! });
    expect(r).toMatchObject({ outcome: 'REJECTED', reason: 'REMOVE_NOT_VERIFIED' });
  });

  it('remove paid no TOKEN -> NO_TOKEN_RESIDUAL; legacy remove without recorded proceeds -> TOKEN_RESIDUAL_UNKNOWN', async () => {
    const zero = await stuckPosition({ removeData: { liquidityZero: true, usdgProceedsRaw: U(10), tokenProceedsRaw: 0n } });
    await expectRejected(zero, await zero.settle(good()), 'NO_TOKEN_RESIDUAL');
    const legacy = await stuckPosition({ removeData: { liquidityZero: true } });
    await expectRejected(legacy, await legacy.settle(good()), 'TOKEN_RESIDUAL_UNKNOWN');
  });

  it('a bot swap attempt that may still land -> EXIT_TX_IN_FLIGHT; a VERIFIED bot swap -> SWAP_ALREADY_VERIFIED (normal close applies)', async () => {
    const ctx = await stuckPosition();
    const swap = await ctx.txAttempts.create(`${ctx.closing.closeIdempotencyKey}:swap:0`, 'exit:swap');
    await ctx.txAttempts.update(swap.id, { status: 'SENT' });
    await expectRejected(ctx, await ctx.settle(good()), 'EXIT_TX_IN_FLIGHT');
    await ctx.txAttempts.update(swap.id, { status: 'VERIFIED' });
    await expectRejected(ctx, await ctx.settle(good()), 'SWAP_ALREADY_VERIFIED');
  });
});

describe('Manual TOKEN settlement via receipt -- HTTP operator action', () => {
  async function appWithStuck(chain?: ManualSettlementChainReader) {
    const { app, deps } = buildTestApp(chain ? { settlementChain: chain } : {});
    const created = await deps.positions.create(makeCreateInput({ tokenAddress: TOKEN, entryUsdgRaw: U(500) }));
    await deps.positions.markActive(created.id, '1', new Date());
    const closing = (await deps.positions.markClosing(created.id, `exit:${created.id}:1`))!;
    const remove = await deps.txAttempts.create(`${closing.closeIdempotencyKey}:removeLiquidity`, 'exit:removeLiquidity');
    await deps.txAttempts.update(remove.id, { status: 'VERIFIED', txHash: REMOVE_HASH, verifyData: { liquidityZero: true, usdgProceedsRaw: U(200), tokenProceedsRaw: RESIDUAL } });
    return { app, deps, id: created.id, key: closing.closeIdempotencyKey! };
  }
  const wallet = (deps: { walletAddress: Address }) => ({ ...S, wallet: deps.walletAddress });

  it('unauthenticated -> 401; invalid token -> 401; an authenticated identity other than the operator -> 403; nothing written', async () => {
    const { app, deps, id, key } = await appWithStuck();
    const body = { txHash: SETTLE_HASH, closeIdempotencyKey: key };
    expect((await request(app).post(`/positions/${id}/settle-token`).send(body)).status).toBe(401);
    expect((await request(app).post(`/positions/${id}/settle-token`).set('Authorization', 'Bearer not-a-token').send(body)).status).toBe(401);
    expect((await request(app).post(`/positions/${id}/settle-token`).set('Authorization', `Bearer ${signAccessToken('someone-else')}`).send(body)).status).toBe(403);
    expect((await deps.positions.findById(id))?.status).toBe('CLOSING');
  });

  it('operator-supplied amounts or force flags are refused outright (400) -- only the receipt is proof', async () => {
    const { app, id, key } = await appWithStuck();
    for (const extra of [{ tokenAmount: '3' }, { usdgAmount: '290' }, { manualProceeds: '1' }, { manualTokenAmount: '1' }, { force: true }, { forceClosed: true }, { assumeSettled: true }]) {
      const res = await request(app).post(`/positions/${id}/settle-token`).set('Authorization', authHeader()).send({ txHash: SETTLE_HASH, closeIdempotencyKey: key, ...extra });
      expect(res.status).toBe(400);
    }
    expect((await request(app).post(`/positions/${id}/settle-token`).set('Authorization', authHeader()).send({ txHash: '0x12', closeIdempotencyKey: key })).status).toBe(400);
    for (const path of ['/positions/force-close', `/positions/${id}/force-close`]) {
      expect((await request(app).post(path).set('Authorization', authHeader()).send({})).status).toBe(404);
    }
  });

  it('authorized operator with a proving receipt -> 200 SETTLED; the same request again -> 200 ALREADY_SETTLED; the stuck view no longer lists it', async () => {
    const pre = buildTestApp();
    const chain = chainWithSettlement(wallet(pre.deps), swapLogs(wallet(pre.deps), RESIDUAL, U(290)));
    const { app, deps, id, key } = await appWithStuck(chain);
    const stuckBefore = await request(app).get('/positions/stuck').set('Authorization', authHeader());
    expect(stuckBefore.body.closingPositions.map((c: { positionId: string }) => c.positionId)).toContain(id);
    expect(stuckBefore.body.closingPositions[0].closeIdempotencyKey).toBe(key);

    const res = await request(app).post(`/positions/${id}/settle-token`).set('Authorization', authHeader()).send({ txHash: SETTLE_HASH, closeIdempotencyKey: key });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'SETTLED', tokenDisposedRaw: RESIDUAL.toString(), usdgProceedsRaw: U(290).toString(), realizedUsdgRaw: U(490).toString() });
    const again = await request(app).post(`/positions/${id}/settle-token`).set('Authorization', authHeader()).send({ txHash: SETTLE_HASH, closeIdempotencyKey: key });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('ALREADY_SETTLED');
    expect(deps.cooldown.recordExit).toHaveBeenCalledTimes(1);
    const stuckAfter = await request(app).get('/positions/stuck').set('Authorization', authHeader());
    expect(stuckAfter.body.closingPositions).toEqual([]);
  });

  it('a rejected proof -> 422 SETTLEMENT_REJECTED with the reason; unknown position -> 404; a pending tx -> 409 (retryable)', async () => {
    const pre = buildTestApp();
    const { app, id, key } = await appWithStuck(chainWithSettlement(wallet(pre.deps), swapLogs(wallet(pre.deps), RESIDUAL - 1n, U(290))));
    const res = await request(app).post(`/positions/${id}/settle-token`).set('Authorization', authHeader()).send({ txHash: SETTLE_HASH, closeIdempotencyKey: key });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ outcome: 'SETTLEMENT_REJECTED', reason: 'INSUFFICIENT_TOKEN_DISPOSED' });
    expect((await request(app).post('/positions/nope/settle-token').set('Authorization', authHeader()).send({ txHash: SETTLE_HASH, closeIdempotencyKey: key })).status).toBe(404);

    const pending = await appWithStuck(chainWithSettlement(wallet(pre.deps), [], { pending: true }));
    expect((await request(pending.app).post(`/positions/${pending.id}/settle-token`).set('Authorization', authHeader()).send({ txHash: SETTLE_HASH, closeIdempotencyKey: pending.key })).status).toBe(409);
  });
});


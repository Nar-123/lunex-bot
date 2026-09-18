import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { backfillRealizedPnl } from '../../src/exits/realizedPnlBackfill';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemoryExitStateRepository } from './inMemoryExitStateRepository';
import { makeCreateInput } from '../positions/fixtures';

const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;

async function makeClosedPosition(
  positions: InMemoryPositionRepository,
  opts: { tokenAddress: Address; entryUsdgRaw?: bigint; realizedUsdgRaw?: bigint | null },
) {
  const created = await positions.create(makeCreateInput({ tokenAddress: opts.tokenAddress, entryUsdgRaw: opts.entryUsdgRaw ?? USDG(500) }));
  await positions.markActive(created.id, '1', new Date());
  await positions.markClosing(created.id, `exit:${created.id}:1`);
  await positions.markClosed(created.id, new Date(), 'HARD_STOP_LOSS', opts.realizedUsdgRaw ?? null);
  const position = await positions.findById(created.id);
  if (!position) throw new Error('unreachable');
  return position;
}

describe('backfillRealizedPnl -- P1-13', () => {
  it('backfills realizedUsdgRaw for a CLOSED position whose remove+swap legs are both VERIFIED but realizedUsdgRaw was never measured at close time', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const exitStates = new InMemoryExitStateRepository();
    const position = await makeClosedPosition(positions, { tokenAddress: '0x0000000000000000000000000000000000000002' });

    const removeAttempt = await txAttempts.create(`exit:${position.id}:1:removeLiquidity`, 'exit:removeLiquidity');
    await txAttempts.update(removeAttempt.id, { status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: USDG(480) } });
    const swapAttempt = await txAttempts.create(`exit:${position.id}:1:swap:0`, 'exit:swap');
    await txAttempts.update(swapAttempt.id, { status: 'VERIFIED', verifyData: { usdgIncreaseRaw: USDG(490), usdgProceedsRaw: USDG(490) } });

    const result = await backfillRealizedPnl({ positions, txAttempts, exitStates });

    expect(result.backfilledPositionIds).toEqual([position.id]);
    expect(result.stillUnmeasuredPositionIds).toHaveLength(0);
    const reloaded = await positions.findById(position.id);
    expect(reloaded?.realizedUsdgRaw).toBe(USDG(970));
  });

  it('never touches a position whose realizedUsdgRaw is already set -- no double-counting, not even re-summed to the same value', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const exitStates = new InMemoryExitStateRepository();
    const position = await makeClosedPosition(positions, { tokenAddress: '0x0000000000000000000000000000000000000002', realizedUsdgRaw: USDG(970) });

    // Even if VERIFIED receipts existed and would sum to something ELSE, an already-measured position must never be recomputed/overwritten.
    const removeAttempt = await txAttempts.create(`exit:${position.id}:1:removeLiquidity`, 'exit:removeLiquidity');
    await txAttempts.update(removeAttempt.id, { status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: USDG(999) } });
    const swapAttempt = await txAttempts.create(`exit:${position.id}:1:swap:0`, 'exit:swap');
    await txAttempts.update(swapAttempt.id, { status: 'VERIFIED', verifyData: { usdgIncreaseRaw: USDG(999), usdgProceedsRaw: USDG(999) } });

    const result = await backfillRealizedPnl({ positions, txAttempts, exitStates });

    expect(result.backfilledPositionIds).toHaveLength(0);
    const reloaded = await positions.findById(position.id);
    expect(reloaded?.realizedUsdgRaw).toBe(USDG(970)); // completely unchanged
  });

  it('leaves realizedUsdgRaw null (reports stillUnmeasured) when one leg is missing/not VERIFIED -- half a measurement is never backfilled', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const exitStates = new InMemoryExitStateRepository();
    const position = await makeClosedPosition(positions, { tokenAddress: '0x0000000000000000000000000000000000000002' });

    const removeAttempt = await txAttempts.create(`exit:${position.id}:1:removeLiquidity`, 'exit:removeLiquidity');
    await txAttempts.update(removeAttempt.id, { status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: USDG(480) } });
    // Swap leg never created/verified at all.

    const result = await backfillRealizedPnl({ positions, txAttempts, exitStates });

    expect(result.backfilledPositionIds).toHaveLength(0);
    expect(result.stillUnmeasuredPositionIds).toEqual([position.id]);
    const reloaded = await positions.findById(position.id);
    expect(reloaded?.realizedUsdgRaw).toBeNull();
  });

  it('leaves realizedUsdgRaw null when the remove-liquidity verifyData is a legacy shape without usdgProceedsRaw', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const exitStates = new InMemoryExitStateRepository();
    const position = await makeClosedPosition(positions, { tokenAddress: '0x0000000000000000000000000000000000000002' });

    const removeAttempt = await txAttempts.create(`exit:${position.id}:1:removeLiquidity`, 'exit:removeLiquidity');
    await txAttempts.update(removeAttempt.id, { status: 'VERIFIED', verifyData: { liquidityZero: true } }); // legacy shape, no proceeds field
    const swapAttempt = await txAttempts.create(`exit:${position.id}:1:swap:0`, 'exit:swap');
    await txAttempts.update(swapAttempt.id, { status: 'VERIFIED', verifyData: { usdgIncreaseRaw: USDG(490), usdgProceedsRaw: USDG(490) } });

    const result = await backfillRealizedPnl({ positions, txAttempts, exitStates });

    expect(result.stillUnmeasuredPositionIds).toEqual([position.id]);
    expect((await positions.findById(position.id))?.realizedUsdgRaw).toBeNull();
  });

  it('derives the swap key from ExitState.swapAttemptCount -- a STALE attempt 0 is ignored once the count reflects a later, successful retry', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const exitStates = new InMemoryExitStateRepository();
    const position = await makeClosedPosition(positions, { tokenAddress: '0x0000000000000000000000000000000000000002' });
    exitStates.seed({ positionId: position.id, swapAttemptCount: 1, trailingPeakPnlPct: null, drawdownConfirmStartedAt: null, oorStartedAt: null, safetyExitArmedAt: null, maxDrawdownPnlPct: null, metricsFailureSince: null, swapUsdgBalanceBeforeRaw: null, swapMinOutputAmountRaw: null, swapVerifiedUsdgIncreaseRaw: null, pendingCloseReason: null });

    const removeAttempt = await txAttempts.create(`exit:${position.id}:1:removeLiquidity`, 'exit:removeLiquidity');
    await txAttempts.update(removeAttempt.id, { status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: USDG(480) } });
    // Attempt 0 FAILED (the retry that bumped the counter to 1); attempt 1 is the one that actually succeeded.
    const staleAttempt = await txAttempts.create(`exit:${position.id}:1:swap:0`, 'exit:swap');
    await txAttempts.update(staleAttempt.id, { status: 'FAILED', failureCode: 'REVERTED' });
    const realAttempt = await txAttempts.create(`exit:${position.id}:1:swap:1`, 'exit:swap');
    await txAttempts.update(realAttempt.id, { status: 'VERIFIED', verifyData: { usdgIncreaseRaw: USDG(490), usdgProceedsRaw: USDG(490) } });

    const result = await backfillRealizedPnl({ positions, txAttempts, exitStates });

    expect(result.backfilledPositionIds).toEqual([position.id]);
    expect((await positions.findById(position.id))?.realizedUsdgRaw).toBe(USDG(970));
  });

  it('is idempotent: running it twice in a row never double-counts or changes an already-backfilled value', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const exitStates = new InMemoryExitStateRepository();
    const position = await makeClosedPosition(positions, { tokenAddress: '0x0000000000000000000000000000000000000002' });

    const removeAttempt = await txAttempts.create(`exit:${position.id}:1:removeLiquidity`, 'exit:removeLiquidity');
    await txAttempts.update(removeAttempt.id, { status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: USDG(480) } });
    const swapAttempt = await txAttempts.create(`exit:${position.id}:1:swap:0`, 'exit:swap');
    await txAttempts.update(swapAttempt.id, { status: 'VERIFIED', verifyData: { usdgIncreaseRaw: USDG(490), usdgProceedsRaw: USDG(490) } });

    const first = await backfillRealizedPnl({ positions, txAttempts, exitStates });
    const second = await backfillRealizedPnl({ positions, txAttempts, exitStates });

    expect(first.backfilledPositionIds).toEqual([position.id]);
    expect(second.backfilledPositionIds).toHaveLength(0); // nothing left to do
    expect(second.stillUnmeasuredPositionIds).toHaveLength(0); // NOT misreported as unmeasured either -- it's measured, just not by this run
    expect((await positions.findById(position.id))?.realizedUsdgRaw).toBe(USDG(970));
  });

  it('never touches an ACTIVE or CLOSING position -- only CLOSED rows are ever candidates', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const exitStates = new InMemoryExitStateRepository();

    const active = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(active.id, '1', new Date());
    const closing = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003' }));
    await positions.markActive(closing.id, '2', new Date());
    await positions.markClosing(closing.id, `exit:${closing.id}:1`);

    const result = await backfillRealizedPnl({ positions, txAttempts, exitStates });

    expect(result.backfilledPositionIds).toHaveLength(0);
    expect(result.stillUnmeasuredPositionIds).toHaveLength(0);
    expect((await positions.findById(active.id))?.status).toBe('ACTIVE');
    expect((await positions.findById(closing.id))?.status).toBe('CLOSING');
  });

  it('multiple CLOSED positions: each is independently measured, no cross-contamination', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const exitStates = new InMemoryExitStateRepository();
    const a = await makeClosedPosition(positions, { tokenAddress: '0x0000000000000000000000000000000000000002' });
    const b = await makeClosedPosition(positions, { tokenAddress: '0x0000000000000000000000000000000000000003', realizedUsdgRaw: USDG(1200) }); // already measured

    const removeA = await txAttempts.create(`exit:${a.id}:1:removeLiquidity`, 'exit:removeLiquidity');
    await txAttempts.update(removeA.id, { status: 'VERIFIED', verifyData: { liquidityZero: true, usdgProceedsRaw: USDG(200) } });
    const swapA = await txAttempts.create(`exit:${a.id}:1:swap:0`, 'exit:swap');
    await txAttempts.update(swapA.id, { status: 'VERIFIED', verifyData: { usdgIncreaseRaw: USDG(210), usdgProceedsRaw: USDG(210) } });

    const result = await backfillRealizedPnl({ positions, txAttempts, exitStates });

    expect(result.backfilledPositionIds).toEqual([a.id]);
    expect((await positions.findById(a.id))?.realizedUsdgRaw).toBe(USDG(410));
    expect((await positions.findById(b.id))?.realizedUsdgRaw).toBe(USDG(1200)); // untouched
  });
});

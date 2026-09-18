import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { runReconciliation } from '../../src/reconciliation/runReconciliation';
import type { NftOwnerChecker, OwnedNftLister, OwnerCheckResult, PositionIdentityChecker, PositionIdentityCheckResult } from '../../src/reconciliation/types';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
import { InMemoryExitStateRepository } from '../exits/inMemoryExitStateRepository';
import { makeCreateInput } from '../positions/fixtures';
import type { LivePositionStateProvider } from '../../src/monitoring/types';

const WALLET = '0x9999999999999999999999999999999999999999' as Address;

function makeLister(tokenIds: string[]): OwnedNftLister {
  return { listOwnedTokenIds: vi.fn(async () => tokenIds) };
}
function makeOwnerChecker(result: OwnerCheckResult | ((tokenId: string) => OwnerCheckResult)): NftOwnerChecker {
  return { checkOwner: vi.fn(async (tokenId: string) => (typeof result === 'function' ? result(tokenId) : result)) };
}
function makeLiveState(liquidity: bigint): LivePositionStateProvider {
  return { getLiveState: vi.fn(async () => ({ liquidity, tokensOwed0: 0n, tokensOwed1: 0n })) };
}
/** Default: every identity check MATCHes -- most tests aren't exercising P1-9/P1-7's identity check, so it should never produce a finding unless a test explicitly wants one. */
function makeIdentityChecker(result: PositionIdentityCheckResult | ((tokenId: string) => PositionIdentityCheckResult) = { status: 'MATCH' }): PositionIdentityChecker {
  return { checkIdentity: vi.fn(async (tokenId: string) => (typeof result === 'function' ? result(tokenId) : result)) };
}
/** Shared base deps every test starts from -- individual tests override just the pieces they're testing. */
function baseDeps(overrides: Partial<Parameters<typeof runReconciliation>[0]> = {}): Parameters<typeof runReconciliation>[0] {
  return {
    positions: new InMemoryPositionRepository(),
    txAttempts: new InMemoryTransactionAttemptRepository(),
    exitStates: new InMemoryExitStateRepository(),
    livePositionState: makeLiveState(500n),
    ownedNftLister: makeLister([]),
    nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
    positionIdentityChecker: makeIdentityChecker(),
    walletAddress: WALLET,
    ...overrides,
  };
}

describe('runReconciliation -- H5', () => {
  it('1. ORPHAN_NFT: wallet owns an NFT with no corresponding non-closed Position row', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();

    const report = await runReconciliation({
      positions,
      txAttempts,
      exitStates: new InMemoryExitStateRepository(),
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister(['999']),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
      positionIdentityChecker: makeIdentityChecker(),
      walletAddress: WALLET,
    });

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'ORPHAN_NFT', tokenId: '999' }));
    expect(report.orphanScanRan).toBe(true);
  });

  it('does NOT flag an owned NFT that DOES have a matching non-closed Position row', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '42', new Date());

    const report = await runReconciliation({
      positions,
      txAttempts,
      exitStates: new InMemoryExitStateRepository(),
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister(['42']),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
      positionIdentityChecker: makeIdentityChecker(),
      walletAddress: WALLET,
    });

    expect(report.findings.filter((f) => f.kind === 'ORPHAN_NFT')).toHaveLength(0);
  });

  it('2. MISSING_NFT: Position ACTIVE in DB but its NFT is confirmed gone on-chain', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '7', new Date());

    const report = await runReconciliation({
      positions,
      txAttempts,
      exitStates: new InMemoryExitStateRepository(),
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'NOT_FOUND_CONFIRMED' }),
      positionIdentityChecker: makeIdentityChecker(),
      walletAddress: WALLET,
    });

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'MISSING_NFT', positionId: created.id, tokenId: '7' }));
  });

  it('fail-safe: an RPC failure checking ownership never produces a MISSING_NFT finding -- surfaces as rpcHealthy:false instead', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '7', new Date());

    const report = await runReconciliation({
      positions,
      txAttempts,
      exitStates: new InMemoryExitStateRepository(),
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'RPC_UNAVAILABLE' }),
      positionIdentityChecker: makeIdentityChecker(),
      walletAddress: WALLET,
    });

    expect(report.findings.filter((f) => f.kind === 'MISSING_NFT')).toHaveLength(0);
    expect(report.rpcHealthy).toBe(false);
  });

  it('fail-safe: the orphan scan itself failing (thrown) never fabricates findings -- surfaces as rpcHealthy:false', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const throwingLister: OwnedNftLister = { listOwnedTokenIds: vi.fn(async () => { throw new Error('RPC down'); }) };

    const report = await runReconciliation({
      positions,
      txAttempts,
      exitStates: new InMemoryExitStateRepository(),
      livePositionState: makeLiveState(500n),
      ownedNftLister: throwingLister,
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
      positionIdentityChecker: makeIdentityChecker(),
      walletAddress: WALLET,
    });

    expect(report.findings.filter((f) => f.kind === 'ORPHAN_NFT')).toHaveLength(0);
    expect(report.rpcHealthy).toBe(false);
  });

  it('3. OPENING_ALREADY_MINTED: mint TransactionAttempt VERIFIED but Position still OPENING', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    const attempt = await txAttempts.create(`${created.openIdempotencyKey}:mint`, 'deploy:mint');
    await txAttempts.update(attempt.id, { status: 'VERIFIED', verifyData: { positionTokenId: '1', liquidity: 500n } });

    const report = await runReconciliation({
      positions,
      txAttempts,
      exitStates: new InMemoryExitStateRepository(),
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
      positionIdentityChecker: makeIdentityChecker(),
      walletAddress: WALLET,
    });

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'OPENING_ALREADY_MINTED', positionId: created.id }));
  });

  it('does not flag OPENING when the mint attempt is not yet VERIFIED', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));

    const report = await runReconciliation({
      positions,
      txAttempts,
      exitStates: new InMemoryExitStateRepository(),
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
      positionIdentityChecker: makeIdentityChecker(),
      walletAddress: WALLET,
    });

    expect(report.findings.filter((f) => f.kind === 'OPENING_ALREADY_MINTED')).toHaveLength(0);
  });

  it('4a. CLOSING_ALREADY_REMOVED: remove-liquidity VERIFIED but Position still CLOSING', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '1', new Date());
    await positions.markClosing(created.id, `exit:${created.id}:1`);
    const removeAttempt = await txAttempts.create(`exit:${created.id}:1:removeLiquidity`, 'exit:removeLiquidity');
    await txAttempts.update(removeAttempt.id, { status: 'VERIFIED', verifyData: { liquidityZero: true } });

    const report = await runReconciliation({
      positions,
      txAttempts,
      exitStates: new InMemoryExitStateRepository(),
      livePositionState: makeLiveState(0n),
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
      positionIdentityChecker: makeIdentityChecker(),
      walletAddress: WALLET,
    });

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'CLOSING_ALREADY_REMOVED', positionId: created.id }));
  });

  it('4b. CLOSING_ALREADY_REMOVED: on-chain liquidity already 0 but no removeLiquidity attempt exists at all', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '1', new Date());
    await positions.markClosing(created.id, `exit:${created.id}:1`);

    const report = await runReconciliation({
      positions,
      txAttempts,
      exitStates: new InMemoryExitStateRepository(),
      livePositionState: makeLiveState(0n), // genuinely 0 on-chain
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
      positionIdentityChecker: makeIdentityChecker(),
      walletAddress: WALLET,
    });

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'CLOSING_ALREADY_REMOVED', positionId: created.id }));
  });

  it('does not flag CLOSING when liquidity is still non-zero and nothing is VERIFIED yet', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '1', new Date());
    await positions.markClosing(created.id, `exit:${created.id}:1`);

    const report = await runReconciliation({
      positions,
      txAttempts,
      exitStates: new InMemoryExitStateRepository(),
      livePositionState: makeLiveState(500n), // still has real liquidity
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
      positionIdentityChecker: makeIdentityChecker(),
      walletAddress: WALLET,
    });

    expect(report.findings.filter((f) => f.kind === 'CLOSING_ALREADY_REMOVED')).toHaveLength(0);
  });

  it('includeOrphanScan:false skips the wallet-wide scan entirely (periodic-tick mode) without touching the lister', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const lister = makeLister(['999']);

    const report = await runReconciliation(
      { positions, txAttempts, exitStates: new InMemoryExitStateRepository(), livePositionState: makeLiveState(500n), ownedNftLister: lister, nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }), positionIdentityChecker: makeIdentityChecker(), walletAddress: WALLET },
      { includeOrphanScan: false },
    );

    expect(lister.listOwnedTokenIds).not.toHaveBeenCalled();
    expect(report.orphanScanRan).toBe(false);
    expect(report.findings.filter((f) => f.kind === 'ORPHAN_NFT')).toHaveLength(0);
  });

  it('never writes to the database -- a full pass with multiple findings leaves every position/attempt status untouched', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '7', new Date());

    await runReconciliation({
      positions,
      txAttempts,
      exitStates: new InMemoryExitStateRepository(),
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'NOT_FOUND_CONFIRMED' }), // would "justify" closing it, but must NOT
      positionIdentityChecker: makeIdentityChecker(),
      walletAddress: WALLET,
    });

    const reloaded = await positions.findById(created.id);
    expect(reloaded?.status).toBe('ACTIVE'); // completely untouched
  });
});

describe('runReconciliation -- P1-7 (expanded matrix)', () => {
  it('6. VERIFIED_SWAP_NOT_CLOSED: the swap leg (not remove-liquidity) reached VERIFIED but Position is still CLOSING', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const exitStates = new InMemoryExitStateRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '1', new Date());
    await positions.markClosing(created.id, `exit:${created.id}:1`);
    // Remove-liquidity leg not yet VERIFIED (so CLOSING_ALREADY_REMOVED must not fire), but the swap leg (attempt 0, matching the default swapAttemptCount) already is.
    const swapAttempt = await txAttempts.create(`exit:${created.id}:1:swap:0`, 'exit:swap');
    await txAttempts.update(swapAttempt.id, { status: 'VERIFIED', verifyData: { usdgIncreaseRaw: 10n, usdgProceedsRaw: 10n } });

    const report = await runReconciliation(baseDeps({ positions, txAttempts, exitStates, livePositionState: makeLiveState(500n) }));

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'VERIFIED_SWAP_NOT_CLOSED', positionId: created.id }));
    expect(report.findings.filter((f) => f.kind === 'CLOSING_ALREADY_REMOVED')).toHaveLength(0);
  });

  it('does not flag VERIFIED_SWAP_NOT_CLOSED when the swap attempt is not yet VERIFIED', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const exitStates = new InMemoryExitStateRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '1', new Date());
    await positions.markClosing(created.id, `exit:${created.id}:1`);

    const report = await runReconciliation(baseDeps({ positions, txAttempts, exitStates, livePositionState: makeLiveState(500n) }));

    expect(report.findings.filter((f) => f.kind === 'VERIFIED_SWAP_NOT_CLOSED')).toHaveLength(0);
  });

  it('the swap check uses the CURRENT attempt key derived from ExitState.swapAttemptCount, not always attempt 0', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const exitStates = new InMemoryExitStateRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '1', new Date());
    await positions.markClosing(created.id, `exit:${created.id}:1`);
    exitStates.seed({ positionId: created.id, swapAttemptCount: 2, trailingPeakPnlPct: null, drawdownConfirmStartedAt: null, oorStartedAt: null, safetyExitArmedAt: null, maxDrawdownPnlPct: null, metricsFailureSince: null, swapUsdgBalanceBeforeRaw: null, swapMinOutputAmountRaw: null, swapVerifiedUsdgIncreaseRaw: null, pendingCloseReason: null });
    // A STALE attempt 0 is VERIFIED (irrelevant -- superseded by retries), but the CURRENT attempt (2) is not.
    const staleAttempt = await txAttempts.create(`exit:${created.id}:1:swap:0`, 'exit:swap');
    await txAttempts.update(staleAttempt.id, { status: 'VERIFIED', verifyData: { usdgIncreaseRaw: 10n, usdgProceedsRaw: 10n } });

    const report = await runReconciliation(baseDeps({ positions, txAttempts, exitStates, livePositionState: makeLiveState(500n) }));

    expect(report.findings.filter((f) => f.kind === 'VERIFIED_SWAP_NOT_CLOSED')).toHaveLength(0);
  });

  it('7. FAILED_MINT_STUCK: mint TransactionAttempt definitively FAILED but Position still OPENING', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    const attempt = await txAttempts.create(`${created.openIdempotencyKey}:mint`, 'deploy:mint');
    await txAttempts.update(attempt.id, { status: 'FAILED', failureCode: 'SIMULATION_REJECTED' });

    const report = await runReconciliation(baseDeps({ positions, txAttempts }));

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'FAILED_MINT_STUCK', positionId: created.id }));
    expect(report.findings.filter((f) => f.kind === 'OPENING_ALREADY_MINTED')).toHaveLength(0); // mutually exclusive with the VERIFIED case
  });

  it('does not flag FAILED_MINT_STUCK for an ambiguous (resumable) mint attempt, only a DEFINITIVE FAILED', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    const attempt = await txAttempts.create(`${created.openIdempotencyKey}:mint`, 'deploy:mint');
    await txAttempts.update(attempt.id, { status: 'SENT' });

    const report = await runReconciliation(baseDeps({ positions, txAttempts }));

    expect(report.findings.filter((f) => f.kind === 'FAILED_MINT_STUCK')).toHaveLength(0);
  });

  it('8. FAILED_REMOVE_STUCK: remove-liquidity TransactionAttempt definitively FAILED but Position still CLOSING', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const exitStates = new InMemoryExitStateRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '1', new Date());
    await positions.markClosing(created.id, `exit:${created.id}:1`);
    const removeAttempt = await txAttempts.create(`exit:${created.id}:1:removeLiquidity`, 'exit:removeLiquidity');
    await txAttempts.update(removeAttempt.id, { status: 'FAILED', failureCode: 'REVERTED' });

    const report = await runReconciliation(baseDeps({ positions, txAttempts, exitStates, livePositionState: makeLiveState(500n) }));

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'FAILED_REMOVE_STUCK', positionId: created.id }));
    expect(report.findings.filter((f) => f.kind === 'CLOSING_ALREADY_REMOVED')).toHaveLength(0); // mutually exclusive with the VERIFIED case
  });

  it('9. IDENTITY_MISMATCH: an ACTIVE position\'s recorded pool does not match its tokenId\'s real on-chain PoolKey', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '55', new Date());

    const identityChecker = makeIdentityChecker({ status: 'MISMATCH', reason: 'minted position\'s on-chain pool fee (500) does not match the expected pool fee (30000)' });
    const report = await runReconciliation(baseDeps({ positions, txAttempts, positionIdentityChecker: identityChecker }));

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'IDENTITY_MISMATCH', positionId: created.id, tokenId: '55' }));
  });

  it('does not flag IDENTITY_MISMATCH when the on-chain PoolKey matches', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '55', new Date());

    const report = await runReconciliation(baseDeps({ positions, txAttempts, positionIdentityChecker: makeIdentityChecker({ status: 'MATCH' }) }));

    expect(report.findings.filter((f) => f.kind === 'IDENTITY_MISMATCH')).toHaveLength(0);
  });

  it('fail-safe: an RPC failure checking identity never produces an IDENTITY_MISMATCH finding -- surfaces as rpcHealthy:false instead', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const created = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    await positions.markActive(created.id, '55', new Date());

    const report = await runReconciliation(baseDeps({ positions, txAttempts, positionIdentityChecker: makeIdentityChecker({ status: 'RPC_UNAVAILABLE' }) }));

    expect(report.findings.filter((f) => f.kind === 'IDENTITY_MISMATCH')).toHaveLength(0);
    expect(report.rpcHealthy).toBe(false);
  });

  it('IDENTITY_MISMATCH is never checked for OPENING positions -- they have no minted tokenId yet', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    const identityChecker = makeIdentityChecker({ status: 'MISMATCH', reason: 'should never be called for an OPENING position' });

    const report = await runReconciliation(baseDeps({ positions, txAttempts, positionIdentityChecker: identityChecker }));

    expect(identityChecker.checkIdentity).not.toHaveBeenCalled();
    expect(report.findings.filter((f) => f.kind === 'IDENTITY_MISMATCH')).toHaveLength(0);
  });

  it('none of the four new P1-7 checks ever write to the database -- a full pass with every new finding kind triggered leaves every row untouched', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const exitStates = new InMemoryExitStateRepository();

    const opening = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000002' }));
    const mintAttempt = await txAttempts.create(`${opening.openIdempotencyKey}:mint`, 'deploy:mint');
    await txAttempts.update(mintAttempt.id, { status: 'FAILED', failureCode: 'REVERTED' });

    const closing = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000003' }));
    await positions.markActive(closing.id, '1', new Date());
    await positions.markClosing(closing.id, `exit:${closing.id}:1`);
    const removeAttempt = await txAttempts.create(`exit:${closing.id}:1:removeLiquidity`, 'exit:removeLiquidity');
    await txAttempts.update(removeAttempt.id, { status: 'FAILED', failureCode: 'REVERTED' });

    const active = await positions.create(makeCreateInput({ tokenAddress: '0x0000000000000000000000000000000000000004' }));
    await positions.markActive(active.id, '99', new Date());

    await runReconciliation(
      baseDeps({
        positions,
        txAttempts,
        exitStates,
        livePositionState: makeLiveState(500n),
        positionIdentityChecker: makeIdentityChecker({ status: 'MISMATCH', reason: 'deliberately mismatched -- must never trigger a write' }),
      }),
    );

    expect((await positions.findById(opening.id))?.status).toBe('OPENING');
    expect((await positions.findById(closing.id))?.status).toBe('CLOSING');
    expect((await positions.findById(active.id))?.status).toBe('ACTIVE');
  });
});

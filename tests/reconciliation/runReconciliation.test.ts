import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { runReconciliation } from '../../src/reconciliation/runReconciliation';
import type { NftOwnerChecker, OwnedNftLister, OwnerCheckResult } from '../../src/reconciliation/types';
import { InMemoryPositionRepository } from '../positions/inMemoryPositionRepository';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';
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

describe('runReconciliation -- H5', () => {
  it('1. ORPHAN_NFT: wallet owns an NFT with no corresponding non-closed Position row', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();

    const report = await runReconciliation({
      positions,
      txAttempts,
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister(['999']),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
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
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister(['42']),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
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
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'NOT_FOUND_CONFIRMED' }),
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
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'RPC_UNAVAILABLE' }),
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
      livePositionState: makeLiveState(500n),
      ownedNftLister: throwingLister,
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
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
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
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
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
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
      livePositionState: makeLiveState(0n),
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
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
      livePositionState: makeLiveState(0n), // genuinely 0 on-chain
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
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
      livePositionState: makeLiveState(500n), // still has real liquidity
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }),
      walletAddress: WALLET,
    });

    expect(report.findings.filter((f) => f.kind === 'CLOSING_ALREADY_REMOVED')).toHaveLength(0);
  });

  it('includeOrphanScan:false skips the wallet-wide scan entirely (periodic-tick mode) without touching the lister', async () => {
    const positions = new InMemoryPositionRepository();
    const txAttempts = new InMemoryTransactionAttemptRepository();
    const lister = makeLister(['999']);

    const report = await runReconciliation(
      { positions, txAttempts, livePositionState: makeLiveState(500n), ownedNftLister: lister, nftOwnerChecker: makeOwnerChecker({ status: 'FOUND', owner: WALLET }), walletAddress: WALLET },
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
      livePositionState: makeLiveState(500n),
      ownedNftLister: makeLister([]),
      nftOwnerChecker: makeOwnerChecker({ status: 'NOT_FOUND_CONFIRMED' }), // would "justify" closing it, but must NOT
      walletAddress: WALLET,
    });

    const reloaded = await positions.findById(created.id);
    expect(reloaded?.status).toBe('ACTIVE'); // completely untouched
  });
});

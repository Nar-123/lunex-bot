import type { Address } from 'viem';
import type { PositionRepository } from '../positions/types';
import type { TransactionAttemptRepository } from '../execution/types';
import type { ExitStateRepository } from '../exits/types';
import type { LivePositionStateProvider } from '../monitoring/types';
import type { NftOwnerChecker, OwnedNftLister, PositionIdentityChecker, ReconciliationFinding, ReconciliationReport } from './types';

export interface RunReconciliationDeps {
  positions: PositionRepository;
  txAttempts: TransactionAttemptRepository;
  exitStates: ExitStateRepository;
  livePositionState: LivePositionStateProvider;
  ownedNftLister: OwnedNftLister;
  nftOwnerChecker: NftOwnerChecker;
  positionIdentityChecker: PositionIdentityChecker;
  walletAddress: Address;
}

export interface RunReconciliationOptions {
  /** The wallet-wide Transfer-log scan (orphan-NFT detection) is the one expensive, whole-history check here -- callers running this every 15s tick should pass `false` and reserve `true` for a slower/startup-only cadence. Defaults to `true`. */
  includeOrphanScan?: boolean;
}

/**
 * H5: runs every reconciliation check against the CURRENT database state
 * and (where needed) live on-chain reads. Pure orchestration -- every
 * dependency is injected, so this is fully unit-testable without a real
 * RPC connection. Never writes anything; only produces a report for a
 * human/existing stuck-detection surface to act on.
 */
export async function runReconciliation(deps: RunReconciliationDeps, options: RunReconciliationOptions = {}): Promise<ReconciliationReport> {
  const includeOrphanScan = options.includeOrphanScan ?? true;
  const findings: ReconciliationFinding[] = [];
  let rpcHealthy = true;

  const nonClosed = await deps.positions.findDeployedPositions(); // OPENING + ACTIVE + CLOSING

  // 1. Orphan NFTs: on-chain, owned by the wallet, no corresponding non-closed Position row.
  if (includeOrphanScan) {
    try {
      const ownedTokenIds = await deps.ownedNftLister.listOwnedTokenIds(deps.walletAddress);
      const dbTokenIds = new Set(nonClosed.map((p) => p.positionTokenId).filter((id): id is string => id !== null));
      for (const tokenId of ownedTokenIds) {
        if (!dbTokenIds.has(tokenId)) {
          findings.push({
            kind: 'ORPHAN_NFT',
            tokenId,
            detail: `wallet owns PositionManager NFT #${tokenId} with no corresponding non-closed Position row -- surfaced as an orphan, NEVER auto-closed/auto-sold`,
          });
        }
      }
    } catch {
      // Can't enumerate at all -- skip this check for this pass, never guess.
      rpcHealthy = false;
    }
  }

  // 2. Missing NFTs: Position ACTIVE/CLOSING in DB, but its NFT is confirmed gone/not-owned on-chain.
  for (const position of nonClosed) {
    if (position.status === 'OPENING' || !position.positionTokenId) continue; // OPENING has no minted tokenId to check yet
    const check = await deps.nftOwnerChecker.checkOwner(position.positionTokenId);
    if (check.status === 'RPC_UNAVAILABLE') {
      rpcHealthy = false;
      continue;
    }
    if (check.status === 'NOT_FOUND_CONFIRMED') {
      findings.push({
        kind: 'MISSING_NFT',
        positionId: position.id,
        tokenId: position.positionTokenId,
        detail: `Position ${position.id} is ${position.status} in the DB but its NFT #${position.positionTokenId} is confirmed gone/not owned by the wallet on-chain`,
      });
      continue;
    }
    // After the RPC_UNAVAILABLE and NOT_FOUND_CONFIRMED branches above
    // (both `continue`), the union is narrowed to exactly `FOUND` here.
    if (check.owner.toLowerCase() !== deps.walletAddress.toLowerCase()) {
      findings.push({
        kind: 'MISSING_NFT',
        positionId: position.id,
        tokenId: position.positionTokenId,
        detail: `Position ${position.id} is ${position.status} in the DB but its NFT #${position.positionTokenId} is now owned by a different address on-chain`,
      });
    }
  }

  // 3. OPENING but the mint already reached VERIFIED on-chain.
  // 7 (P1-7). OPENING but the mint DEFINITIVELY FAILED and was never marked FAILED.
  const opening = await deps.positions.findAllOpening();
  for (const position of opening) {
    const mintAttempt = await deps.txAttempts.find(`${position.openIdempotencyKey}:mint`);
    if (mintAttempt?.status === 'VERIFIED') {
      findings.push({
        kind: 'OPENING_ALREADY_MINTED',
        positionId: position.id,
        detail: `mint TransactionAttempt for position ${position.id} is VERIFIED but the Position row is still OPENING -- should self-heal on the next open-resume tick (see C1/C7); flagged here as an independent cross-check`,
      });
    } else if (mintAttempt?.status === 'FAILED') {
      findings.push({
        kind: 'FAILED_MINT_STUCK',
        positionId: position.id,
        detail: `mint TransactionAttempt for position ${position.id} is definitively FAILED but the Position row is still OPENING (never transitioned to FAILED) -- capital/token-slot reservations may still be held for a position that will never open`,
      });
    }
  }

  // 4. CLOSING but liquidity is already genuinely gone on-chain.
  // 8 (P1-7). CLOSING but the remove-liquidity leg DEFINITIVELY FAILED and was never reverted to ACTIVE.
  // 6 (P1-7). CLOSING but the SWAP leg already reached VERIFIED on-chain.
  const closing = await deps.positions.findAllClosing();
  for (const position of closing) {
    if (!position.closeIdempotencyKey) continue;
    const removeAttempt = await deps.txAttempts.find(`${position.closeIdempotencyKey}:removeLiquidity`);
    if (removeAttempt?.status === 'VERIFIED') {
      findings.push({
        kind: 'CLOSING_ALREADY_REMOVED',
        positionId: position.id,
        detail: `remove-liquidity TransactionAttempt for position ${position.id} is VERIFIED but the Position row is still CLOSING -- should self-heal on the next exit-cycle tick (see C3); flagged here as an independent cross-check`,
      });
    } else if (removeAttempt?.status === 'FAILED') {
      findings.push({
        kind: 'FAILED_REMOVE_STUCK',
        positionId: position.id,
        detail: `remove-liquidity TransactionAttempt for position ${position.id} is definitively FAILED but the Position row is still CLOSING (never reverted to ACTIVE via markExitFailed)`,
      });
    } else if (position.positionTokenId) {
      try {
        const live = await deps.livePositionState.getLiveState(position);
        if (live.liquidity === 0n && removeAttempt === null) {
          // Liquidity already reads 0 on-chain but NO TransactionAttempt was
          // ever created for the remove-liquidity leg -- something removed
          // it outside this bot's own tracked flow, or a genuine data gap.
          findings.push({
            kind: 'CLOSING_ALREADY_REMOVED',
            positionId: position.id,
            tokenId: position.positionTokenId,
            detail: `Position ${position.id} is CLOSING and its on-chain liquidity already reads 0, but no removeLiquidity TransactionAttempt exists in the DB -- surfaced as stuck/orphaned, needs manual review`,
          });
        }
      } catch {
        rpcHealthy = false;
      }
    }

    // P1-7: the SWAP leg is a SEPARATE TransactionAttempt from remove-liquidity
    // (see executeExit.ts's C3 short-circuit) -- checked independently of
    // whichever branch above fired, using the SAME current-attempt key
    // `executeExit.ts` itself derives from `ExitState.swapAttemptCount`.
    const exitState = await deps.exitStates.getOrCreate(position.id);
    const swapKey = `${position.closeIdempotencyKey}:swap:${exitState.swapAttemptCount}`;
    const swapAttempt = await deps.txAttempts.find(swapKey);
    if (swapAttempt?.status === 'VERIFIED') {
      findings.push({
        kind: 'VERIFIED_SWAP_NOT_CLOSED',
        positionId: position.id,
        detail: `swap TransactionAttempt for position ${position.id} is VERIFIED but the Position row is still CLOSING -- should self-heal on the next exit-cycle tick (see executeExit.ts's C3 short-circuit); flagged here as an independent cross-check`,
      });
    }
  }

  // 9 (P1-7/P1-9). ACTIVE/CLOSING positions with a minted tokenId: does the
  // DB's recorded pool identity match the tokenId's REAL on-chain PoolKey?
  // Read-only historical/corruption check -- a NEW mint can never reach
  // ACTIVE with a mismatch (mintTx.ts's verifyOnChain already prevents
  // that), so this exists for rows written before that fix, or by any
  // other path.
  for (const position of nonClosed) {
    if (position.status === 'OPENING' || !position.positionTokenId) continue;
    const identity = await deps.positionIdentityChecker.checkIdentity(position.positionTokenId, position.pool);
    if (identity.status === 'RPC_UNAVAILABLE') {
      rpcHealthy = false;
      continue;
    }
    if (identity.status === 'MISMATCH') {
      findings.push({
        kind: 'IDENTITY_MISMATCH',
        positionId: position.id,
        tokenId: position.positionTokenId,
        detail: `Position ${position.id}'s recorded pool identity does not match its NFT #${position.positionTokenId}'s real on-chain PoolKey: ${identity.reason}`,
      });
    }
  }

  return { findings, checkedAt: new Date(), rpcHealthy, orphanScanRan: includeOrphanScan };
}

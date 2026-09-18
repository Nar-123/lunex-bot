import type { Address } from 'viem';
import type { PositionPoolContext } from '../positions/types';

/**
 * H5: on-chain <-> database reconciliation. The original five divergence
 * categories named in the audit, each mapped to a `ReconciliationFinding`
 * kind:
 *
 *  1. ORPHAN_NFT                    -- NFT on-chain owned by the wallet, no corresponding non-CLOSED Position row.
 *  2. MISSING_NFT                   -- Position ACTIVE/CLOSING in DB, its NFT no longer exists/owned on-chain.
 *  3. OPENING_ALREADY_MINTED        -- mint TransactionAttempt VERIFIED, Position still OPENING.
 *  4. CLOSING_ALREADY_REMOVED       -- remove-liquidity VERIFIED (or on-chain liquidity reads 0 with no attempt at all), Position still CLOSING.
 *  5. (folded into 3/4 above) -- "a VERIFIED TransactionAttempt whose domain state isn't final" is exactly what 3 and 4 each detect for their respective leg.
 *
 * P1-7 fix: expanded the matrix with four more finding kinds a later audit
 * asked for, all still read-only, all still fail-safe on any RPC failure:
 *
 *  6. VERIFIED_SWAP_NOT_CLOSED      -- the exit's SWAP leg (not remove-liquidity, kind 4's leg) reached VERIFIED, but the Position row is still CLOSING. Same "should self-heal on the next tick" relationship kind 3/4 have to their own legs -- see `executeExit.ts`'s C3 short-circuit.
 *  7. FAILED_MINT_STUCK             -- the mint TransactionAttempt reached a DEFINITIVE FAILED, but the Position row is still OPENING (never transitioned to FAILED, releasing its capital/token-slot reservations). A real gap: nothing today automatically reconciles this domain/transaction state mismatch (openPosition.ts's own definitive-failure path DOES call markFailed in the same request that discovers FAILED -- this finding exists for the case where that never ran, e.g. the process died between the two).
 *  8. FAILED_REMOVE_STUCK           -- the remove-liquidity TransactionAttempt reached a DEFINITIVE FAILED, but the Position row is still CLOSING (never reverted to ACTIVE via `markExitFailed`). Same reasoning as 7, for the close side.
 *  9. IDENTITY_MISMATCH             -- an ACTIVE/CLOSING position's RECORDED pool (currency0/currency1/fee/tickSpacing/hooks) does not match its minted tokenId's REAL on-chain PoolKey (via `PositionManager.getPoolAndPositionInfo` -- see `positions/mintTx.ts`'s P1-9 fix, which this reuses). Historical/legacy-data-corruption detection: `mintTx.ts`'s own `verifyOnChain` already prevents a NEW mint from ever reaching ACTIVE with a mismatched identity, so this specifically catches a row that predates that fix, or corruption from any other write path.
 *
 * Deliberately fail-safe throughout (explicit requirement): every check
 * that needs an on-chain read distinguishes `NOT_FOUND_CONFIRMED` (a real,
 * decoded on-chain fact -- e.g. an ERC721 revert for a nonexistent token)
 * from `RPC_UNAVAILABLE` (the read itself failed) from `AMBIGUOUS`. Only
 * `NOT_FOUND_CONFIRMED` (or an unconditionally-readable DB/attempt-status
 * fact) ever produces a finding; an RPC failure during a check pass is
 * surfaced via `ReconciliationReport.rpcHealthy: false`, never silently
 * treated as "confirmed clean" or, worse, as grounds to auto-modify data.
 * Nothing in this module ever writes to the database or the chain -- it
 * only SURFACES findings (via `ExitCycleSummary`, the same existing
 * stuck-detection surface `GET /positions/stuck` already reads), for a
 * human to act on. The four new checks are no exception: they only ever
 * push to `findings` or flip `rpcHealthy`, never call any repository's
 * write methods -- see `runReconciliation.test.ts`'s "P1-7" tests for the
 * explicit no-mutation assertions.
 */
export type ReconciliationFindingKind =
  | 'ORPHAN_NFT'
  | 'MISSING_NFT'
  | 'OPENING_ALREADY_MINTED'
  | 'CLOSING_ALREADY_REMOVED'
  | 'VERIFIED_SWAP_NOT_CLOSED'
  | 'FAILED_MINT_STUCK'
  | 'FAILED_REMOVE_STUCK'
  | 'IDENTITY_MISMATCH';

export interface ReconciliationFinding {
  kind: ReconciliationFindingKind;
  positionId?: string;
  tokenId?: string;
  detail: string;
}

export interface ReconciliationReport {
  findings: ReconciliationFinding[];
  checkedAt: Date;
  /** False if ANY on-chain read needed for this pass failed -- the findings list may be incomplete this pass; never treated as "confirmed clean." */
  rpcHealthy: boolean;
  /** Whether the (expensive, wallet-wide) orphan-NFT scan ran this pass -- see runReconciliation's `includeOrphanScan` option. */
  orphanScanRan: boolean;
}

/** Port: enumerates every positionTokenId the wallet currently owns, via the PositionManager's own on-chain Transfer history. MUST throw on RPC failure -- never return an empty/partial list silently. */
export interface OwnedNftLister {
  listOwnedTokenIds(wallet: Address): Promise<string[]>;
}

export type OwnerCheckResult = { status: 'FOUND'; owner: Address } | { status: 'NOT_FOUND_CONFIRMED' } | { status: 'RPC_UNAVAILABLE' };

/** Port: checks a single NFT's current owner, explicitly distinguishing a confirmed-nonexistent token from a failed read. */
export interface NftOwnerChecker {
  checkOwner(tokenId: string): Promise<OwnerCheckResult>;
}

export type PositionIdentityCheckResult =
  | { status: 'MATCH' }
  | { status: 'MISMATCH'; reason: string }
  | { status: 'RPC_UNAVAILABLE' };

/** P1-7/P1-9 port: cross-checks a minted tokenId's REAL on-chain PoolKey against the pool this codebase's DB believes it belongs to. Real implementation reuses `positions/mintTx.ts`'s `checkMintedPoolIdentity` (the same pure comparison the mint's OWN verification uses) against a fresh `PositionManager.getPoolAndPositionInfo` read -- see that file's doc comment for why tickLower/tickUpper are NOT part of this comparison (packed on-chain field, bit layout not verifiable in this environment). */
export interface PositionIdentityChecker {
  checkIdentity(tokenId: string, expectedPool: PositionPoolContext): Promise<PositionIdentityCheckResult>;
}

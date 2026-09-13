import type { Address } from 'viem';

/**
 * H5: on-chain <-> database reconciliation. The five divergence
 * categories named in the audit, each mapped to a `ReconciliationFinding`
 * kind:
 *
 *  1. ORPHAN_NFT                    -- NFT on-chain owned by the wallet, no corresponding non-CLOSED Position row.
 *  2. MISSING_NFT                   -- Position ACTIVE/CLOSING in DB, its NFT no longer exists/owned on-chain.
 *  3. OPENING_ALREADY_MINTED        -- mint TransactionAttempt VERIFIED, Position still OPENING.
 *  4. CLOSING_ALREADY_REMOVED       -- remove-liquidity VERIFIED (or on-chain liquidity reads 0 with no attempt at all), Position still CLOSING.
 *  5. (folded into 3/4 above) -- "a VERIFIED TransactionAttempt whose domain state isn't final" is exactly what 3 and 4 each detect for their respective leg.
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
 * human to act on.
 */
export type ReconciliationFindingKind = 'ORPHAN_NFT' | 'MISSING_NFT' | 'OPENING_ALREADY_MINTED' | 'CLOSING_ALREADY_REMOVED';

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

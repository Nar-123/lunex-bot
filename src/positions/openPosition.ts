import { randomUUID } from 'node:crypto';
import type { Address } from 'viem';
import { config } from '../config';
import { readErc20Allowance } from '../blockchain/erc20';
import { getExecutorAddress } from '../blockchain/walletClient';
import { executeCriticalTransaction } from '../execution/executeCriticalTransaction';
import type { TransactionAttemptRepository, TxSafetyDeps } from '../execution/types';
import type { LivePositionStateProvider, PoolPriceProvider } from '../monitoring/types';
import type { CreatePositionInput, PositionPoolContext, PositionRecord, PositionRepository } from './types';
import { buildApproveDeps as realBuildApproveDeps, needsApproval, type ApproveVerifyData } from './approveTx';
import { buildMintDeps as realBuildMintDeps, type MintInput, type MintVerifyData } from './mintTx';

export type OpenPositionOutcome =
  | { outcome: 'ACTIVE'; position: PositionRecord }
  | { outcome: 'FAILED'; reason: string }
  | { outcome: 'PENDING'; reason: string };

export interface OpenPositionInput {
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  pool: PositionPoolContext;
  tickLower: number;
  tickUpper: number;
  /** The decided position size -- `decideCapitalAllocation`'s `positionSizeUsdgRaw` (35% of free USDG, already checked against the 3-position and 90%-exposure caps). */
  entryUsdgRaw: bigint;
  /** The pool price snapshot the range/decision were computed from (Modules 3/4) -- the PNL basis, recorded once, never recomputed. The ACTUAL mint transaction reads a FRESH live price at build time (see `mintTx.ts`), same as `exits/removeLiquidityTx.ts` -- these two can legitimately differ if price moved between decision and execution. */
  entryTick: number;
  entrySqrtPriceX96: bigint;
}

export interface OpenPositionDeps {
  positions: PositionRepository;
  txAttempts: TransactionAttemptRepository;
  livePositionState: LivePositionStateProvider;
  poolPrice: PoolPriceProvider;
  /** Injectable, defaulting to the real implementations -- same testability reasoning as `exits/executeExit.ts`'s equivalent fields. */
  buildApproveDeps?: (amountInRaw: bigint) => TxSafetyDeps<ApproveVerifyData>;
  buildMintDeps?: (input: MintInput, live: LivePositionStateProvider, pool: PoolPriceProvider) => TxSafetyDeps<MintVerifyData>;
  readAllowance?: (tokenAddress: Address, owner: Address, spender: Address) => Promise<bigint>;
  walletAddress?: Address;
}

/**
 * Starts a brand-new open-position attempt: creates the `Position` row
 * (status OPENING, a fresh `openIdempotencyKey`) BEFORE any
 * `executeCriticalTransaction` call -- same reasoning as every other
 * critical flow in this project (the row must exist first so the same key
 * covers the whole flow for crash recovery, per Revision 6). Called by the
 * 30-minute screening cycle once a candidate has passed every filter and
 * `decideCapitalAllocation` has approved a size.
 */
export async function openPosition(input: OpenPositionInput, deps: OpenPositionDeps): Promise<OpenPositionOutcome> {
  const createInput: CreatePositionInput = {
    tokenAddress: input.tokenAddress,
    tokenSymbol: input.tokenSymbol,
    tokenDecimals: input.tokenDecimals,
    pool: input.pool,
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
    entryUsdgRaw: input.entryUsdgRaw,
    entrySqrtPriceX96: input.entrySqrtPriceX96,
    entryTick: input.entryTick,
    openIdempotencyKey: `deploy:${input.tokenAddress}:${randomUUID()}`,
  };
  const created = await deps.positions.create(createInput);
  return executeOpen(created, deps);
}

/**
 * Resumes an open-position attempt already in flight -- a position at
 * OPENING found by `positions.findAllOpening()` (the mint-side mirror of
 * `exits/`'s `findAllClosing()` resume pass). Uses the position's
 * EXISTING `openIdempotencyKey`, unchanged: unlike `exits/`'s two-transaction
 * flow, a single-transaction mint has no earlier already-VERIFIED leg to
 * protect from duplication, so there is no fresh-key-per-retry pattern
 * here -- `executeCriticalTransaction`'s own idempotency resumes exactly
 * where the last attempt left off (e.g. a crash between SIGNED and
 * broadcast resumes from SIGNED, never re-signing).
 */
export async function resumeOpenPosition(position: PositionRecord, deps: OpenPositionDeps): Promise<OpenPositionOutcome> {
  return executeOpen(position, deps);
}

/**
 * The failed-open state machine -- deliberately SIMPLER than `exits/`'s,
 * per explicit review: this is ONE mandatory transaction (mint) plus one
 * CONDITIONAL transaction (approve, only if the current USDG allowance
 * for the PositionManager is insufficient) -- never two mandatory legs
 * where the first's success changes what "failure" means for the second.
 * A USDG-only one-sided deposit needs no swap up front (the decided size
 * is already USDG), so there is no analogue to `exits/`'s
 * remove-liquidity-then-swap sequencing risk at all.
 *
 * **Any DEFINITIVE failure -- in EITHER leg -- gets the SAME simple
 * response: `markFailed`, full stop.** No fresh-idempotency-key retry
 * pattern (unlike `exits/`'s swap leg): if approve or mint fails
 * definitively, nothing irreversible has happened (USDG never left the
 * wallet -- an approve() only sets an allowance, and a failed mint never
 * pulls funds), so this candidate is simply released. Its capital
 * automatically returns to `freeUsdgBalance` via the accounting already
 * proven correct in Revision 7 (a `FAILED` position is excluded from both
 * `reservedForOpening` and `totalDeployedUsdg` -- neither sum needed any
 * change for this module either, for the exact same reason). Retrying the
 * SAME mint with a fresh key would be actively wrong, not just
 * unnecessary: the pool price has moved since the candidate was decided,
 * and the candidate itself may no longer be worth opening -- the correct
 * "retry" is the NEXT 30-minute screening cycle evaluating fresh
 * candidates against fresh prices, not this module blindly re-attempting
 * stale parameters.
 *
 * **An AMBIGUOUS (`resumable: true`) failure in either leg** leaves the
 * position at OPENING, retried with the SAME idempotencyKey -- ordinary
 * Module 6 resumability, nothing extra needed.
 *
 * A position is marked ACTIVE ONLY after `mintTx.ts`'s `verifyOnChain`
 * confirms a real `positionTokenId` was discovered AND its on-chain
 * liquidity reads > 0 -- never on broadcast success or receipt confirmation
 * alone.
 */
async function executeOpen(position: PositionRecord, deps: OpenPositionDeps): Promise<OpenPositionOutcome> {
  const buildApproveDeps = deps.buildApproveDeps ?? realBuildApproveDeps;
  const buildMintDeps = deps.buildMintDeps ?? realBuildMintDeps;
  const readAllowance = deps.readAllowance ?? readErc20Allowance;
  const wallet = deps.walletAddress ?? getExecutorAddress();
  const usdgAddress = config.quoteAsset.ADDRESS as Address;
  const positionManagerAddress = config.uniswap.v4.positionManager as Address;

  const currentAllowance = await readAllowance(usdgAddress, wallet, positionManagerAddress);
  if (needsApproval(currentAllowance, position.entryUsdgRaw)) {
    const approveKey = `${position.openIdempotencyKey}:approve`;
    const approveDeps = buildApproveDeps(position.entryUsdgRaw);
    const approveResult = await executeCriticalTransaction(approveKey, 'deploy:approve', approveDeps, deps.txAttempts);

    if (!approveResult.ok) {
      if (!approveResult.resumable) {
        await deps.positions.markFailed(position.id);
        return { outcome: 'FAILED', reason: approveResult.reason };
      }
      return { outcome: 'PENDING', reason: approveResult.reason };
    }
  }

  const mintKey = `${position.openIdempotencyKey}:mint`;
  const mintInput: MintInput = {
    tokenAddress: position.tokenAddress,
    tokenSymbol: position.tokenSymbol,
    tokenDecimals: position.tokenDecimals,
    pool: position.pool,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    entryUsdgRaw: position.entryUsdgRaw,
  };
  const mintDeps = buildMintDeps(mintInput, deps.livePositionState, deps.poolPrice);
  const mintResult = await executeCriticalTransaction(mintKey, 'deploy:mint', mintDeps, deps.txAttempts);

  if (!mintResult.ok) {
    if (!mintResult.resumable) {
      await deps.positions.markFailed(position.id);
      return { outcome: 'FAILED', reason: mintResult.reason };
    }
    return { outcome: 'PENDING', reason: mintResult.reason };
  }

  const updated = await deps.positions.markActive(position.id, mintResult.data.positionTokenId, new Date());
  return { outcome: 'ACTIVE', position: updated };
}

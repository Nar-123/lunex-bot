import type { Address } from 'viem';
import { config } from '../config';
import { readErc20Allowance, readErc20Balance } from '../blockchain/erc20';
import { getExecutorAddress } from '../blockchain/walletClient';
import { executeCriticalTransaction } from '../execution/executeCriticalTransaction';
import type { TransactionAttemptRepository, TxSafetyDeps } from '../execution/types';
import type { PositionRecord, PositionRepository } from '../positions/types';
import type { LivePositionStateProvider, PoolPriceProvider } from '../monitoring/types';
import type { SwapExecutor, SwapQuote } from '../swap/types';
import type { ExitStateRepository } from './types';
import { buildRemoveLiquidityDeps as realBuildRemoveLiquidityDeps } from './removeLiquidityTx';
import { buildSwapDeps as realBuildSwapDeps, defaultLogImpact, shouldBlockForPriceImpact, type SwapVerifyData } from './swapTx';
import { buildApproveDeps as realBuildApproveDeps, needsApproval, type ApproveVerifyData } from './approveTx';

export type ExitExecutionOutcome =
  | { outcome: 'CLOSED' }
  | { outcome: 'REVERTED_TO_ACTIVE'; reason: string }
  | { outcome: 'SWAP_FAILED_RETRY_PENDING'; reason: string }
  | { outcome: 'PENDING'; reason: string };

export interface ExecuteExitDeps {
  positions: PositionRepository;
  exitStates: ExitStateRepository;
  txAttempts: TransactionAttemptRepository;
  livePositionState: LivePositionStateProvider;
  poolPrice: PoolPriceProvider;
  swapExecutor: SwapExecutor;
  /**
   * Injectable, defaulting to the real on-chain implementations
   * (`removeLiquidityTx.ts`/`swapTx.ts`/`approveTx.ts`) -- exactly the same
   * reason `execution/executeCriticalTransaction.test.ts` tests against
   * fully fake `TxSafetyDeps` rather than real viem calls: this is what
   * makes the STATE MACHINE in this file (the failure branches, the
   * idempotency-key derivation) testable in complete isolation from any
   * real RPC/API call. Tests inject a fake here to control exactly how
   * each leg "fails" without needing a live chain.
   */
  buildRemoveLiquidityDeps?: (position: PositionRecord, live: LivePositionStateProvider, pool: PoolPriceProvider) => TxSafetyDeps<{ liquidityZero: true }>;
  buildSwapDeps?: (
    positionId: string,
    tokenAddress: PositionRecord['tokenAddress'],
    quote: SwapQuote,
    swap: SwapExecutor,
    exitStates: ExitStateRepository,
  ) => TxSafetyDeps<SwapVerifyData>;
  buildApproveDeps?: (tokenAddress: Address, spender: Address, amountInRaw: bigint) => TxSafetyDeps<ApproveVerifyData>;
  /** Injectable for tests -- defaults to the real on-chain ERC20 reads. */
  readTokenBalance?: (tokenAddress: Address, wallet: Address) => Promise<bigint>;
  readAllowance?: (tokenAddress: Address, owner: Address, spender: Address) => Promise<bigint>;
  walletAddress?: Address;
  logImpact?: (positionId: string, priceImpactPct: number) => void;
}

/**
 * The exit flow's orchestrator, and the failure-state-machine this module
 * was reviewed most strictly on before any code was written.
 *
 * ## Why multiple legs, multiple idempotency keys, different failure responses
 *
 * The exit flow is up to THREE separate `executeCriticalTransaction`
 * calls, not one -- Tx A (remove-liquidity + collect fees, one on-chain
 * tx, see `removeLiquidityTx.ts`), an OPTIONAL Tx (a plain ERC20
 * `approve()`, see `approveTx.ts` -- only when the swap quote's
 * `allowanceTarget` isn't already sufficiently approved; see "Permit2
 * opt-out" below), then Tx B (TOKEN->USDG swap, see `swapTx.ts`).
 * `executeCriticalTransaction` caches a `FAILED` `TransactionAttempt` and
 * returns it immediately, forever, for that same idempotencyKey -- BY
 * DESIGN (Module 6), so a definitive failure is never silently retried
 * under the same key. That single fact is why this function's failure
 * branches below look so different from each other, even though the
 * user's original proposal (mirroring the `markFailed`/Revision-7 pattern)
 * assumed one uniform "revert and retry with a fresh key" response would
 * cover every case:
 *
 * **Tx A (remove-liquidity) fails definitively, before ever reaching
 * VERIFIED**: the LP is still 100% intact -- nothing changed on-chain, so
 * "this position never started exiting" is the TRUE state. `markExitFailed`
 * reverts status CLOSING -> ACTIVE and clears `closeIdempotencyKey`, so the
 * NEXT exit attempt (next tick, trigger re-evaluated completely fresh)
 * calls `markClosing` again with a BRAND NEW key -- never resuming the
 * dead one. This is exactly the user's proposed fix, and it is correct
 * for this branch.
 *
 * **The approve leg, or Tx B (swap), fails definitively, AFTER Tx A
 * already reached VERIFIED**: the LP is genuinely gone -- liquidity is 0,
 * the wallet holds raw TOKEN, USDG hasn't arrived. Reverting to ACTIVE
 * here would be WRONG: there is no LP left to monitor or compute PNL
 * against, and capital would be misrepresented as "still an LP position"
 * when it is actually naked TOKEN exposure. The position correctly STAYS
 * CLOSING -- this is not a "stuck forever, no way out" state (the same
 * shape of bug `markFailed` fixed in Revision 7): `ExitState.swapAttemptCount`
 * is incremented (both the approve leg and the swap leg share this SAME
 * counter -- from a "did the post-remove-liquidity half of this exit
 * succeed" perspective they are one unit of work), and the NEXT retry
 * derives FRESH approve/swap keys from the bumped counter
 * (`${closeIdempotencyKey}:approve:${n}` / `:swap:${n}`) while the
 * remove-liquidity key stays untouched and stable, so Tx A's cached
 * `VERIFIED` result is found and short-circuited for free -- Tx A is NEVER
 * rebuilt, re-signed, or re-broadcast on a retry of this half.
 *
 * ## Permit2 opt-out, not EIP-712 signing
 *
 * The Trading API's default flow can require a Permit2 SIGNATURE (an
 * off-chain EIP-712 signature, not a transaction) instead of a plain
 * `approve()`. This project has no EIP-712 signing capability anywhere --
 * every other integration point signs and broadcasts real transactions
 * through this exact pipeline. Rather than half-implement signing as a
 * one-off special case, `swap/tradingApiClient.ts` explicitly requests
 * Permit2 be disabled, and `swap/tradingApiMapper.ts` independently
 * verifies the resulting quote's `permitData` is actually null --
 * throwing loudly (never silently falling back to guessing) if the API
 * still wants a permit despite the opt-out request. When the opt-out
 * holds, `quote.allowanceTarget` names an ordinary ERC20 spender, and the
 * approve leg above is a normal transaction like any other.
 *
 * `capitalSnapshotProvider.ts` needs NO change for any of these branches:
 * reverting to ACTIVE keeps the position in `NON_CLOSED_STATUSES` (still
 * correctly counted as deployed, still occupies a slot) exactly as
 * before; staying at CLOSING is already unconditionally included by
 * Revision 5's fix, regardless of which CLOSING sub-phase (LP-still-there
 * vs. LP-already-removed-approve-or-swap-pending) the position is
 * actually in -- the capital is genuinely still at risk either way
 * (arguably MORE at risk as naked TOKEN than as an LP position), so
 * counting it as deployed remains correct. See
 * `tests/exits/executeExit.test.ts` for the numeric proof, including the
 * counter-proof of what "stuck forever" would look like if the same key
 * were reused instead of a fresh one.
 */
export async function executeExit(position: PositionRecord, deps: ExecuteExitDeps): Promise<ExitExecutionOutcome> {
  if (!position.closeIdempotencyKey) {
    throw new Error(`cannot execute exit for position ${position.id}: status is ${position.status} but closeIdempotencyKey is null`);
  }

  const buildRemoveLiquidityDeps = deps.buildRemoveLiquidityDeps ?? realBuildRemoveLiquidityDeps;
  const buildSwapDeps = deps.buildSwapDeps ?? realBuildSwapDeps;
  const buildApproveDeps = deps.buildApproveDeps ?? realBuildApproveDeps;
  const readTokenBalance = deps.readTokenBalance ?? readErc20Balance;
  const readAllowance = deps.readAllowance ?? readErc20Allowance;
  const wallet = deps.walletAddress ?? getExecutorAddress();
  const logImpact = deps.logImpact ?? defaultLogImpact;

  const removeKey = `${position.closeIdempotencyKey}:removeLiquidity`;
  const removeDeps = buildRemoveLiquidityDeps(position, deps.livePositionState, deps.poolPrice);
  const removeResult = await executeCriticalTransaction(removeKey, 'exit:removeLiquidity', removeDeps, deps.txAttempts);

  if (!removeResult.ok) {
    if (!removeResult.resumable) {
      // Definitive, and Tx A never reached VERIFIED -- LP fully intact.
      await deps.positions.markExitFailed(position.id);
      return { outcome: 'REVERTED_TO_ACTIVE', reason: removeResult.reason };
    }
    // Ambiguous (broadcast uncertain, etc.) -- retry the SAME key next tick, executeCriticalTransaction resumes from the last checkpoint.
    return { outcome: 'PENDING', reason: removeResult.reason };
  }

  // From here on, the LP is gone -- a definitive failure in EITHER the
  // approve leg or the swap leg shares the SAME "stay CLOSING, bump
  // swapAttemptCount, retry with a fresh key" response.
  const exitState = await deps.exitStates.getOrCreate(position.id);

  const amountInRaw = await readTokenBalance(position.tokenAddress, wallet);
  if (amountInRaw <= 0n) {
    throw new Error(`position ${position.id}: remove-liquidity is VERIFIED but TOKEN balance reads 0 -- invariant violated`);
  }
  const quote = await deps.swapExecutor.getQuote(position.tokenAddress, amountInRaw);
  logImpact(position.id, quote.priceImpactPct);
  if (shouldBlockForPriceImpact(quote.priceImpactPct, config.rules.exits.IMPACT_CHECK_ENABLED, config.rules.priceImpact.MAX_EXIT_IMPACT_PCT)) {
    // Not a definitive failure -- conditions right now are bad, not
    // permanently invalid; no TransactionAttempt is even created for this
    // tick. Retried next tick once impact may have improved.
    return {
      outcome: 'PENDING',
      reason: `exit swap price impact ${(quote.priceImpactPct * 100).toFixed(2)}% exceeds max ${(config.rules.priceImpact.MAX_EXIT_IMPACT_PCT * 100).toFixed(2)}% -- IMPACT_CHECK_ENABLED is on, deferring this swap`,
    };
  }

  if (quote.allowanceTarget !== null) {
    const currentAllowance = await readAllowance(position.tokenAddress, wallet, quote.allowanceTarget);
    if (needsApproval(currentAllowance, amountInRaw)) {
      const approveKey = `${position.closeIdempotencyKey}:approve:${exitState.swapAttemptCount}`;
      const approveDeps = buildApproveDeps(position.tokenAddress, quote.allowanceTarget, amountInRaw);
      const approveResult = await executeCriticalTransaction(approveKey, 'exit:approve', approveDeps, deps.txAttempts);

      if (!approveResult.ok) {
        if (!approveResult.resumable) {
          await deps.exitStates.incrementSwapAttempt(position.id);
          return { outcome: 'SWAP_FAILED_RETRY_PENDING', reason: approveResult.reason };
        }
        return { outcome: 'PENDING', reason: approveResult.reason };
      }
    }
  }

  const swapKey = `${position.closeIdempotencyKey}:swap:${exitState.swapAttemptCount}`;
  const swapDeps = buildSwapDeps(position.id, position.tokenAddress, quote, deps.swapExecutor, deps.exitStates);
  const swapResult = await executeCriticalTransaction(swapKey, 'exit:swap', swapDeps, deps.txAttempts);

  if (!swapResult.ok) {
    if (!swapResult.resumable) {
      // Definitive, but Tx A is ALREADY VERIFIED -- LP is gone, cannot
      // revert to ACTIVE. Bump the counter so the next retry gets fresh
      // approve/swap keys; position stays CLOSING (correct -- see doc comment above).
      await deps.exitStates.incrementSwapAttempt(position.id);
      return { outcome: 'SWAP_FAILED_RETRY_PENDING', reason: swapResult.reason };
    }
    return { outcome: 'PENDING', reason: swapResult.reason };
  }

  if (!exitState.pendingCloseReason) {
    // Invariant violation, not a recoverable condition: markClosing() is
    // the only place `pendingCloseReason` is ever set, and it MUST be set
    // before this function is ever called (see `runExitCycle.ts`) --
    // never silently default to some trigger reason here.
    throw new Error(`position ${position.id} completed its exit but ExitState.pendingCloseReason was never set`);
  }
  await deps.positions.markClosed(position.id, new Date(), exitState.pendingCloseReason);
  return { outcome: 'CLOSED' };
}

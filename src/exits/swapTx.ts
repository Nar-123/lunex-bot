import type { Address } from 'viem';
import { config } from '../config';
import { readErc20Balance, readErc20TransfersTo } from '../blockchain/erc20';
import { getExecutorAddress } from '../blockchain/walletClient';
import type { TxSafetyDeps } from '../execution/types';
import * as txSteps from '../execution/viemTxSteps';
import type { SwapExecutor, SwapQuote } from '../swap/types';
import type { ExitStateRepository } from './types';

export interface SwapVerifyData {
  usdgIncreaseRaw: bigint;
  /** VALIDATION PHASE: USDG the swap's own confirmed receipt paid the wallet (realized-PnL measurement -- exact, immune to concurrent wallet activity, unlike the balance delta above which stays as the safety check). */
  usdgProceedsRaw: bigint;
}

/**
 * Extracted as its own pure function (parameters explicit, not read from
 * `config` inline) so both states of this toggleable flag can be
 * unit-tested directly -- same reasoning as
 * `capital/decideCapitalAllocation.ts`'s `checkEthGasReserve`. OFF by
 * default per spec; price impact is computed and logged unconditionally by
 * the caller regardless of this function's result -- this only decides
 * whether it's allowed to BLOCK the swap.
 */
export function shouldBlockForPriceImpact(priceImpactPct: number | null, enabled: boolean, maxExitImpactPct: number): boolean {
  if (!enabled) return false;
  // TIER 3: an UNVERIFIABLE impact (provider omitted the field, or it
  // arrived non-finite) blocks. When the gate is on, "we could not measure
  // the cost of leaving" must never resolve to "the cost of leaving is
  // fine" -- that is the one direction this check exists to prevent. The
  // caller treats a block as a deferral (PENDING, resumable), not a
  // definitive failure, so an intermittently-quiet provider costs a tick,
  // never the position.
  if (priceImpactPct === null) return true;
  return priceImpactPct > maxExitImpactPct;
}

/**
 * Tx B (or C, when a preceding `approveTx.ts` leg ran) of the exit flow:
 * TOKEN -> USDG, via whichever `SwapExecutor` is injected (Uniswap Trading
 * API in production -- see `swap/tradingApiClient.ts` for why GMGN was
 * ruled out). This function never signs or broadcasts anything itself --
 * the returned `TxSafetyDeps` is run through `execution/`'s
 * `executeCriticalTransaction`, same as every other critical transaction
 * in this project.
 *
 * Takes an ALREADY-FETCHED `quote` rather than calling
 * `swapExecutor.getQuote()` itself -- `executeExit.ts` fetches ONE quote
 * per attempt up front (immediately after remove-liquidity is verified),
 * because that same quote's `allowanceTarget` decides whether the
 * conditional `approveTx.ts` leg runs BEFORE this one; fetching a second,
 * possibly-different quote here would let the approve amount and the swap
 * amount silently disagree.
 *
 * Price impact is ALWAYS computed and logged by `executeExit.ts` (via the
 * injected `logImpact`) before this function is ever called, regardless
 * of `EXITS.IMPACT_CHECK_ENABLED` -- that flag only controls whether
 * `executeExit.ts` defers the swap entirely for this tick; by the time a
 * `quote` reaches this function, it has already been decided safe to
 * proceed. `shouldBlockForPriceImpact` is still exported and used there,
 * not duplicated here.
 *
 * `verifyOnChain` needs a "before" USDG balance baseline that survives a
 * process restart between broadcast and confirmation -- captured once, in
 * `buildTransaction` (which runs exactly once per attempt and is skipped on
 * resume), persisted to `ExitState` (`swapUsdgBalanceBeforeRaw`/
 * `swapMinOutputAmountRaw`) precisely so a resumed `verifyOnChain` call, in
 * a potentially different process, still has the correct baseline instead
 * of re-reading a balance that may already reflect the swap's own effect.
 *
 * `quote` may be `null` ONLY for resume-only deps: `executeExit.ts` passes
 * null when the attempt under this key already holds a signed payload, so
 * `buildTransaction` is never reached (executeCriticalTransaction skips it
 * past BUILT) and no fresh quote is fetched for a swap that may already be
 * on-chain. If it is somehow reached anyway, it throws (resumable) rather
 * than build calldata from nothing.
 */
export interface BuildSwapDepsOptions {
  /** Injectable for tests -- defaults to the real on-chain ERC20 read (same reasoning as `capitalSnapshotProvider.ts`'s `readBalance` default). */
  readBalance?: (tokenAddress: Address, walletAddress: Address) => Promise<bigint>;
  /** Injectable for tests -- defaults to the real receipt-log decoder (`blockchain/erc20.ts`'s `readErc20TransfersTo`). */
  readUsdgTransfersTo?: (txHash: `0x${string}`, tokenAddress: Address, walletAddress: Address) => Promise<bigint>;
  /** Injectable for tests -- defaults to the real configured executor wallet. */
  walletAddress?: Address;
}

export function buildSwapDeps(
  positionId: string,
  tokenAddress: Address,
  quote: SwapQuote | null,
  swapExecutor: SwapExecutor,
  exitStates: ExitStateRepository,
  options: BuildSwapDepsOptions = {},
): TxSafetyDeps<SwapVerifyData> {
  const readBalance = options.readBalance ?? readErc20Balance;
  const readUsdgTransfersTo = options.readUsdgTransfersTo ?? readErc20TransfersTo;
  const usdgAddress = config.quoteAsset.ADDRESS as Address;
  const wallet = options.walletAddress ?? getExecutorAddress();

  return {
    buildTransaction: async () => {
      if (quote === null) {
        throw new Error(`cannot build exit swap tx for position ${positionId}: resume-only deps have no quote -- an already-signed swap attempt must never be rebuilt`);
      }
      const usdgBalanceBefore = await readBalance(usdgAddress, wallet);
      await exitStates.update(positionId, {
        swapUsdgBalanceBeforeRaw: usdgBalanceBefore,
        swapMinOutputAmountRaw: quote.minOutputAmountRaw,
        swapVerifiedUsdgIncreaseRaw: null, // a new attempt has not passed its balance check yet
      });

      return swapExecutor.buildSwapTx(tokenAddress, quote);
    },
    simulate: txSteps.simulateTx,
    estimateGas: txSteps.estimateGasForTx,
    getGasPrice: txSteps.getCurrentGasPrice,
    checkGasAffordable: txSteps.checkGasAffordableOnChain,
    getNonce: txSteps.getCurrentNonce,
    signTransaction: txSteps.signTx,
    broadcastRaw: txSteps.broadcastRawTx,
    waitForReceipt: txSteps.waitForTxReceipt,
    getReceiptIfAvailable: txSteps.getReceiptIfAvailable,
    verifyOnChain: async (confirmedTxHash) => {
      const exitState = await exitStates.getOrCreate(positionId);
      let usdgIncreaseRaw: bigint;
      if (exitState.swapVerifiedUsdgIncreaseRaw !== null) {
        // An earlier call already accepted this attempt's balance increase
        // (then failed only on the proceeds read below). Never re-read the
        // live balance: concurrent wallet activity since then could push it
        // below the baseline and falsely fail a swap that already filled.
        usdgIncreaseRaw = exitState.swapVerifiedUsdgIncreaseRaw;
      } else {
        if (exitState.swapUsdgBalanceBeforeRaw === null) {
          return { ok: false, reason: 'no swapUsdgBalanceBeforeRaw baseline recorded -- cannot verify (invariant violated: buildTransaction should have set this)' };
        }
        const minIncrease = exitState.swapMinOutputAmountRaw ?? 0n;
        const usdgBalanceAfter = await readBalance(usdgAddress, wallet);
        usdgIncreaseRaw = usdgBalanceAfter - exitState.swapUsdgBalanceBeforeRaw;

        // "Genuinely increased" (spec's literal requirement) when protection
        // is off (minIncrease === 0n): usdgIncreaseRaw > 0n is required, NOT
        // just >= 0n -- a swap that had zero effect must fail verification
        // even though 0 >= 0 would trivially pass a naive >= check.
        if (usdgIncreaseRaw <= 0n || usdgIncreaseRaw < minIncrease) {
          return {
            ok: false,
            reason: `USDG balance increased by only ${usdgIncreaseRaw} (required > 0${minIncrease > 0n ? ` and >= ${minIncrease}` : ''})`,
          };
        }
        await exitStates.update(positionId, { swapVerifiedUsdgIncreaseRaw: usdgIncreaseRaw });
      }
      // VALIDATION PHASE: realized proceeds from THIS swap's own confirmed
      // receipt. The swap is already proven by the balance check above, so a
      // failed proceeds read is `resumable: true` -- the attempt stays
      // CONFIRMED, swapAttemptCount is never bumped, and the swap is never
      // re-sent. (P1 fix: this used to return a plain `ok: false`, which the
      // pipeline treats as a definitive VERIFICATION_FAILED.)
      let usdgProceedsRaw: bigint;
      try {
        usdgProceedsRaw = await readUsdgTransfersTo(confirmedTxHash, usdgAddress, wallet);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, resumable: true, reason: `swap verified but proceeds could not be measured: ${message}` };
      }
      return { ok: true, data: { usdgIncreaseRaw, usdgProceedsRaw } };
    },
  };
}

/** Used by `executeExit.ts` (which now owns the price-impact log/block decision, made before this file's `buildTransaction` ever runs). */
export function defaultLogImpact(positionId: string, priceImpactPct: number | null): void {
  // Temporary: replaced by the shared logger once a logging module exists (same caveat as every other not-yet-centralized log call in this project).
  const impactText = priceImpactPct === null ? 'UNAVAILABLE (provider did not report it)' : `${(priceImpactPct * 100).toFixed(3)}%`;
  console.info(`[exits] position ${positionId} exit swap price impact: ${impactText}`);
}

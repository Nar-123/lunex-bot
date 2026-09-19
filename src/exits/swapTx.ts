import type { Address } from 'viem';
import { config } from '../config';
import { readErc20Balance, readErc20TransfersTo } from '../blockchain/erc20';
import { getExecutorAddress } from '../blockchain/walletClient';
import type { TxSafetyDeps } from '../execution/types';
import * as txSteps from '../execution/viemTxSteps';
import type { SwapExecutor, SwapQuote } from '../swap/types';
import type { ExitStateRepository } from './types';

/**
 * Same-attempt swap race fix: the quote-derived snapshot an exit-swap
 * attempt's calldata was built from. Returned by `buildTransaction` INSIDE
 * the `TxRequest` (as `buildContext`), so `executeCriticalTransaction`
 * persists it in the SAME version-checked BUILT write as the calldata --
 * one attempt, one owner, one quote snapshot. Every value comes from the
 * SAME `quote` object `swapExecutor.buildSwapTx` encoded, in the same call.
 * No quote id is invented: the Trading API response carries none (see
 * `swap/types.ts`), and none is needed -- the calldata and this snapshot
 * are bound by being persisted together atomically.
 */
export interface ExitSwapBuildContext {
  kind: 'exit-swap/v1';
  positionId: string;
  swapAttemptCount: number;
  amountInRaw: bigint;
  expectedAmountOutRaw: bigint;
  minOutputAmountRaw: bigint;
  priceImpactPct: number | null;
  slippageBps: number;
  /** Wallet USDG balance read by THIS builder just before building (defense-in-depth balance-delta baseline, never the primary proof). */
  usdgBalanceBeforeRaw: bigint;
}

/** Reads back a persisted `ExitSwapBuildContext`, or `null` for an attempt built before it existed (legacy) or anything malformed. */
export function readExitSwapBuildContext(buildContext: unknown): ExitSwapBuildContext | null {
  if (typeof buildContext !== 'object' || buildContext === null) return null;
  const c = buildContext as Partial<ExitSwapBuildContext>;
  if (c.kind !== 'exit-swap/v1') return null;
  if (typeof c.minOutputAmountRaw !== 'bigint' || typeof c.usdgBalanceBeforeRaw !== 'bigint' || typeof c.amountInRaw !== 'bigint' || typeof c.expectedAmountOutRaw !== 'bigint') return null;
  return c as ExitSwapBuildContext;
}

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
 * `verifyOnChain` needs the minimum output and a "before" USDG balance
 * baseline that survive a process restart between broadcast and
 * confirmation. They are captured in `buildTransaction` and persisted INSIDE
 * the attempt's own `txRequest` (`ExitSwapBuildContext`), by the same
 * version-checked BUILT write that persists the calldata -- so a resumed
 * `verifyOnChain` (in any process) reads the values that belong to THIS
 * attempt's calldata. (Before the same-attempt race fix they lived in
 * `ExitState.swapUsdgBalanceBeforeRaw`/`swapMinOutputAmountRaw`, shared per
 * position and written before ownership was decided; those columns are now
 * read only for attempts built before the fix.)
 *
 * `quote` may be `null` ONLY for resume-only deps: `executeExit.ts` passes
 * null when the attempt under this key already holds a signed payload, so
 * `buildTransaction` is never reached (executeCriticalTransaction skips it
 * past BUILT) and no fresh quote is fetched for a swap that may already be
 * on-chain. If it is somehow reached anyway, it throws (resumable) rather
 * than build calldata from nothing.
 */
export interface BuildSwapDepsOptions {
  /**
   * The swap attempt number (ExitState.swapAttemptCount) this deps object
   * belongs to. `buildTransaction` refuses to build (read-only check, no
   * write) once the counter has moved past it, and records it in the
   * attempt's `ExitSwapBuildContext`. When omitted, the current count is
   * read once and used.
   */
  swapAttemptCount?: number;
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
      // Same-attempt swap race fix: this builder has NO persistent side
      // effect any more. It used to write the quote's minimum output and
      // the USDG baseline to ExitState here -- BEFORE the attempt's
      // version-checked BUILT write decided which worker owns the attempt --
      // so two workers on the same attempt (after a claim lease expired)
      // both wrote, the last writer won, and the stored minimum could come
      // from a DIFFERENT quote than the calldata that won the BUILT write.
      // Now the snapshot is returned WITH the calldata and persisted
      // atomically with it (see `ExitSwapBuildContext`); a losing worker's
      // BUILT write fails its version check and its snapshot is simply
      // discarded -- it never builds on, signs, or broadcasts anything.
      //
      // Read-only staleness check (no write): a worker still holding an
      // older attempt number stops here, before any build.
      const attemptNumber = options.swapAttemptCount ?? (await exitStates.getOrCreate(positionId)).swapAttemptCount;
      const current = await exitStates.getOrCreate(positionId);
      if (current.swapAttemptCount !== attemptNumber) {
        throw new Error(`exit swap for position ${positionId}: swap attempt ${attemptNumber} is no longer current (now ${current.swapAttemptCount}) -- stale worker, not building`);
      }
      const usdgBalanceBefore = await readBalance(usdgAddress, wallet);
      const tx = await swapExecutor.buildSwapTx(tokenAddress, quote);
      const buildContext: ExitSwapBuildContext = {
        kind: 'exit-swap/v1',
        positionId,
        swapAttemptCount: attemptNumber,
        amountInRaw: quote.amountInRaw,
        expectedAmountOutRaw: quote.expectedAmountOutRaw,
        minOutputAmountRaw: quote.minOutputAmountRaw,
        priceImpactPct: quote.priceImpactPct,
        slippageBps: quote.slippageBps,
        usdgBalanceBeforeRaw: usdgBalanceBefore,
      };
      return { to: tx.to, data: tx.data, value: tx.value, buildContext };
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
    verifyOnChain: async (confirmedTxHash, attempt) => {
      // Same-attempt swap race fix: the minimum and baseline come from the
      // snapshot persisted WITH this attempt's own calldata -- never from
      // per-position state another worker could have written. Attempts
      // built before this fix (no snapshot) keep the old ExitState source.
      const built = readExitSwapBuildContext(attempt?.txRequest?.buildContext);
      const legacyState = built === null ? await exitStates.getOrCreate(positionId) : null;
      const minRequired = built !== null ? built.minOutputAmountRaw : (legacyState?.swapMinOutputAmountRaw ?? 0n);
      const baseline = built !== null ? built.usdgBalanceBeforeRaw : (legacyState?.swapUsdgBalanceBeforeRaw ?? null);

      // P0-5 fix: PRIMARY proof is now the swap's OWN CONFIRMED RECEIPT,
      // not a wallet-wide balance delta. `readUsdgTransfersTo` decodes
      // ONLY the ERC20 `Transfer(... -> wallet)` events emitted inside
      // THIS EXACT transaction hash's receipt (blockchain/erc20.ts) --
      // scoped to (exact tx hash, expected token, expected recipient), the
      // "at minimum" bar this fix requires. This closes the false-positive
      // the old balance-delta-as-primary-proof allowed: a swap that
      // genuinely paid 0 USDG, followed by an UNRELATED incoming USDG
      // transfer to the same wallet before this check ran, used to read as
      // a real balance increase and be accepted as VERIFIED. A receipt
      // scoped to one already-mined transaction cannot be inflated by
      // anything that happens in a DIFFERENT transaction, before or after.
      //
      // KNOWN LIMITATION (documented, not solved by this fix): if the
      // swap's OWN transaction itself emits MULTIPLE separate
      // `Transfer(...->wallet)` events of USDG (e.g. an unusual multi-hop
      // router path with an intermediate pass-through), `readUsdgTransfersTo`
      // sums all of them -- a full route/path-aware proof (validating the
      // specific DEX/router emitted exactly the expected swap leg) is not
      // implemented here; flagged for a follow-up rather than guessed at.
      let usdgProceedsRaw: bigint;
      try {
        usdgProceedsRaw = await readUsdgTransfersTo(confirmedTxHash, usdgAddress, wallet);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The tx IS confirmed (we were handed its hash by the pipeline
        // after waitForReceipt succeeded) -- a failure to READ/DECODE that
        // receipt is a transport/parsing problem, never proof the swap
        // failed. Resumable: never marks VERIFICATION_FAILED for a read we
        // simply couldn't perform yet.
        return { ok: false, resumable: true, reason: `could not read the swap's own confirmed receipt to measure proceeds: ${message}` };
      }

      // "Genuinely paid something" (spec's literal requirement) is
      // `usdgProceedsRaw > 0n`, NOT just `>= 0n` -- a swap whose receipt
      // shows zero USDG paid to the wallet must fail verification even
      // though `0 >= 0` would trivially pass a naive `>=` check. Combined
      // with the minimum-output enforcement (previously only checked
      // against the balance delta, now checked against the receipt-scoped
      // proof directly).
      if (usdgProceedsRaw <= 0n || usdgProceedsRaw < minRequired) {
        return {
          ok: false,
          reason: `swap's own confirmed receipt (tx ${confirmedTxHash}) shows only ${usdgProceedsRaw} USDG paid to the wallet (required > 0${minRequired > 0n ? ` and >= ${minRequired}` : ''})`,
        };
      }

      // DEFENSE-IN-DEPTH ONLY, never the primary gate (P0-5's explicit
      // requirement: "balance delta can only be defense-in-depth"). A
      // wallet-wide balance-delta cross-check, kept purely for
      // observability/anomaly-surfacing and to preserve
      // `swapVerifiedUsdgIncreaseRaw`'s existing resume-safety role (a
      // resumed call skips re-reading a balance concurrent activity may
      // have since moved) -- its outcome can NEVER by itself flip
      // verification from fail to pass, and a read failure here is
      // swallowed rather than blocking an already receipt-proven success.
      let usdgIncreaseRaw: bigint | null = legacyState?.swapVerifiedUsdgIncreaseRaw ?? null;
      if (usdgIncreaseRaw === null && baseline !== null) {
        try {
          const usdgBalanceAfter = await readBalance(usdgAddress, wallet);
          usdgIncreaseRaw = usdgBalanceAfter - baseline;
          // Legacy attempts only: keep the old resume-cache behavior. A
          // snapshot-built attempt needs no shared cache -- its baseline is
          // its own, and this value is observability, never the gate.
          if (legacyState !== null) await exitStates.updateSwapLegFields(positionId, legacyState.swapAttemptCount, { swapVerifiedUsdgIncreaseRaw: usdgIncreaseRaw });
        } catch {
          // Best-effort only -- never blocks a receipt-proven verification.
        }
      }

      return { ok: true, data: { usdgIncreaseRaw: usdgIncreaseRaw ?? 0n, usdgProceedsRaw } };
    },
  };
}

/** Used by `executeExit.ts` (which now owns the price-impact log/block decision, made before this file's `buildTransaction` ever runs). */
export function defaultLogImpact(positionId: string, priceImpactPct: number | null): void {
  // Temporary: replaced by the shared logger once a logging module exists (same caveat as every other not-yet-centralized log call in this project).
  const impactText = priceImpactPct === null ? 'UNAVAILABLE (provider did not report it)' : `${(priceImpactPct * 100).toFixed(3)}%`;
  console.info(`[exits] position ${positionId} exit swap price impact: ${impactText}`);
}

import type { Address } from 'viem';
import type { TxRequest } from '../execution/types';

/** A quote for TOKEN -> USDG, before any calldata has been built for it. */
export interface SwapQuote {
  amountInRaw: bigint;
  expectedAmountOutRaw: bigint;
  /** 0n when `EXITS.MIN_RECEIVED_PROTECTION_ENABLED` is false -- that is the expected, valid shape in that mode, not a red flag (see `validateSwapQuote.ts`). */
  minOutputAmountRaw: bigint;
  /**
   * The provider's own price-impact reading, as a fraction (0.005 = 0.5%).
   *
   * TIER 3: NULLABLE. The Trading API's `priceImpact` is an optional field,
   * and the pre-Tier-3 mapper defaulted a missing one to `0` -- which,
   * once the exit-impact gate became a real blocking check, would have
   * meant "the provider didn't tell us" silently passing as "zero impact,"
   * the most permissive possible reading of missing data. `null` now means
   * UNVERIFIED and `shouldBlockForPriceImpact` defers the swap on it (see
   * `exits/swapTx.ts`).
   */
  priceImpactPct: number | null;
  /** TIER 3: the slippage tier (in basis points) this quote was requested with -- 100/200/300 per `EXITS.SLIPPAGE_TIERS_BPS`, escalating only on a DEFINITIVE prior failure. Recorded on the quote so the value that actually reached the router is visible downstream. */
  slippageBps: number;
  /**
   * C5 fix: the real Uniswap Trading API's quote response has NO
   * `allowanceTarget` field at all (confirmed against the live OpenAPI
   * spec -- the previous field here was an invented/assumed name that
   * doesn't exist). The real mechanism is a separate `POST
   * /check_approval` call (see `SwapExecutor.checkApproval` below);
   * `exits/executeExit.ts` calls it explicitly instead of reading a
   * (nonexistent) field off the quote.
   *
   * The exact, OPAQUE `quote` object the Trading API returned from `POST
   * /v1/quote` -- must be echoed back verbatim inside `POST /v1/swap`'s
   * request body (`{ quote: providerQuote }`), per the real API's
   * contract: the swap endpoint is built FROM a whole prior quote object,
   * not re-derived from scalar fields resent by the caller. Never
   * inspected or mutated by anything outside `swap/tradingApiClient.ts`.
   */
  providerQuote: unknown;
}

/**
 * Result of `SwapExecutor.checkApproval` -- C5 fix, replacing the
 * nonexistent `allowanceTarget` quote field. `spender` is the contract
 * that needs an ERC20 allowance from us before the swap can pull
 * `tokenIn`; `null` when the real API's `POST /check_approval` reports no
 * approval transaction is needed for this amount/wallet at all.
 */
export interface ApprovalCheck {
  needsApproval: boolean;
  spender: Address | null;
}

/**
 * Port: quotes and builds UNSIGNED calldata for a TOKEN -> USDG swap.
 * Never signs or broadcasts anything itself -- `exits/swapTx.ts` always
 * runs the returned `TxRequest` through `execution/`'s
 * `executeCriticalTransaction`, exactly like every other critical
 * transaction in this project. Swappable behind this interface without
 * touching `exits/`'s orchestration (see `tradingApiClient.ts`'s doc
 * comment for why the Uniswap Trading API, not GMGN, implements it).
 */
export interface SwapExecutor {
  /**
   * TIER 3: `slippageBps` is REQUIRED and comes from the caller's current
   * tier (`EXITS.SLIPPAGE_TIERS_BPS[swapAttemptCount]`), never from a
   * default inside the client -- the whole point of the ladder is that
   * attempt 1 is tight (100 bps) and only a definitively-failed attempt
   * earns a wider one, so the decision of "how wide" belongs to the
   * caller that knows the attempt history.
   */
  getQuote(tokenIn: Address, amountInRaw: bigint, slippageBps: number): Promise<SwapQuote>;
  /**
   * C5 fix: replaces reading a (nonexistent) `allowanceTarget` field off
   * the quote. Calls the real API's `POST /check_approval` to learn
   * whether an approval transaction is needed for `tokenIn`/`amountInRaw`
   * and, if so, which contract to approve -- `exits/executeExit.ts` then
   * builds its OWN exact-amount `approve()` via `exits/approveTx.ts`
   * (never blindly broadcasts a possibly-unbounded approval calldata the
   * API itself might return).
   */
  checkApproval(tokenIn: Address, amountInRaw: bigint): Promise<ApprovalCheck>;
  /** `quote` must be the exact object `getQuote` just returned -- implementations MUST verify the built calldata is actually FOR this quote's amount (see `validateSwapQuote.ts`), never blindly trust a stale/mismatched quote. */
  buildSwapTx(tokenIn: Address, quote: SwapQuote): Promise<TxRequest>;
}

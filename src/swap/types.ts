import type { Address } from 'viem';
import type { TxRequest } from '../execution/types';

/** A quote for TOKEN -> USDG, before any calldata has been built for it. */
export interface SwapQuote {
  amountInRaw: bigint;
  expectedAmountOutRaw: bigint;
  /** 0n when `EXITS.MIN_RECEIVED_PROTECTION_ENABLED` is false -- that is the expected, valid shape in that mode, not a red flag (see `validateSwapQuote.ts`). */
  minOutputAmountRaw: bigint;
  /** Always computed, regardless of `EXITS.IMPACT_CHECK_ENABLED` -- for logging/visibility even when it can't block the swap. */
  priceImpactPct: number;
  /**
   * The contract that must hold an ERC20 allowance from us before the swap
   * transaction can pull `tokenIn` -- `null` when the provider didn't
   * supply one (e.g. no on-chain allowance is needed for this route).
   * `exits/approveTx.ts` checks/sets this BEFORE the swap leg runs; see
   * `swap/tradingApiClient.ts`'s doc comment for why this project opts out
   * of Permit2 (an off-chain signature) in favor of a plain `approve()`
   * (an ordinary transaction through the same `executeCriticalTransaction`
   * pipeline as everything else).
   */
  allowanceTarget: Address | null;
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
  getQuote(tokenIn: Address, amountInRaw: bigint): Promise<SwapQuote>;
  /** `quote` must be the exact object `getQuote` just returned -- implementations MUST verify the built calldata is actually FOR this quote's amount (see `validateSwapQuote.ts`), never blindly trust a stale/mismatched quote. */
  buildSwapTx(tokenIn: Address, quote: SwapQuote): Promise<TxRequest>;
}

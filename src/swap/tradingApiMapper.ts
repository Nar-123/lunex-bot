import { z } from 'zod';
import type { Address } from 'viem';
import type { SwapQuote } from './types';
import type { RawSwapTxCandidate } from './validateSwapQuote';

/**
 * FLAGGED, NOT VERIFIED: the Uniswap Trading API's exact endpoint paths and
 * JSON field names below are a best-effort assumption, not confirmed
 * against real API docs (no network access from here) -- same category of
 * uncertainty this project already flags elsewhere (e.g.
 * `blockchain/abis/v4StateView.ts`'s "best-effort, unconfirmed" functions).
 * This file is deliberately the ONLY place that assumption lives -- if the
 * real API's shape differs, only this mapper (and its schemas) needs to
 * change; `tradingApiClient.ts`, `validateSwapQuote.ts`, and everything in
 * `exits/` are written against our own `SwapQuote`/`RawSwapTxCandidate`
 * shapes, not the raw JSON.
 */

export class TradingApiMappingError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'TradingApiMappingError';
  }
}

/**
 * The API's `routing` field can be a CLASSIC on-chain swap (`CLASSIC`,
 * `WRAP`, `UNWRAP`, `BRIDGE` -- normal flow: call `/swap`, get raw
 * calldata, sign+broadcast it ourselves via `executeCriticalTransaction`)
 * OR a UniswapX order (`DUTCH_V2`, `DUTCH_V3`, `PRIORITY` -- a
 * fundamentally different flow: sign an off-chain ORDER, submit it to
 * `/order`, and wait for a third-party filler to execute it -- there is no
 * transaction for us to build/simulate/broadcast/verify at all). This
 * project's entire transaction-safety pipeline (Module 6) is built around
 * signing and broadcasting OUR OWN transactions -- it has no concept of
 * "submit an order and wait for a filler." UniswapX routing is therefore
 * flatly incompatible, not just undesirable, and is REJECTED outright
 * rather than ever being handed to `executeCriticalTransaction`.
 */
const UNISWAPX_ROUTING_TYPES = ['DUTCH_V2', 'DUTCH_V3', 'PRIORITY'] as const;
const CLASSIC_ROUTING_TYPES = ['CLASSIC', 'WRAP', 'UNWRAP', 'BRIDGE'] as const;

export class TradingApiUnsupportedRoutingError extends Error {
  constructor(public readonly routing: string) {
    super(
      `Trading API returned UniswapX routing ("${routing}") despite the quote request restricting \`protocols\` to classic AMM routing -- ` +
        `this project's executeCriticalTransaction pipeline signs and broadcasts transactions, it has no concept of signing a UniswapX order ` +
        `and waiting for a third-party filler. Refusing to process this as ordinary calldata.`,
    );
    this.name = 'TradingApiUnsupportedRoutingError';
  }
}

/**
 * Permit2 requires an off-chain EIP-712 SIGNATURE (not a transaction) that
 * this project has no existing capability for -- every other integration
 * point in this codebase (deploy, remove-liquidity, this swap's own
 * calldata) is a signed+broadcast ON-CHAIN TRANSACTION through
 * `executeCriticalTransaction`. Rather than half-implement EIP-712 signing
 * as a one-off special case, this integration explicitly requests Permit2
 * be DISABLED (see `tradingApiClient.ts`'s `x-permit2-disabled` header) so
 * the API falls back to a plain ERC20 `approve()` -- itself an ordinary
 * on-chain transaction, run through the exact same pipeline as everything
 * else (see `exits/approveTx.ts`). If the API still returns `permitData`
 * despite that request, the assumption this integration is built on
 * (Permit2 can be opted out of) has NOT held -- this is a loud failure,
 * not a silent fallback to an unimplemented signing path.
 */
export class TradingApiPermitRequiredError extends Error {
  constructor() {
    super(
      'Trading API returned non-null permitData even though Permit2 was explicitly requested to be disabled -- ' +
        'this integration has no EIP-712 signing capability and refuses to guess; the plain-approve() opt-out this code depends on did not take effect.',
    );
    this.name = 'TradingApiPermitRequiredError';
  }
}

/** Assumed POST /v1/quote response shape (EXACT_INPUT quote). */
const quoteResponseSchema = z
  .object({
    routing: z.string(),
    permitData: z.unknown().nullable().optional(),
    // The contract that must hold an ERC20 allowance from us to pull
    // `tokenIn` -- assumed field name; needed so `exits/approveTx.ts` can
    // check/set allowance BEFORE calling `/swap`, without having to call
    // `/swap` first just to discover the spender.
    allowanceTarget: z.string().optional(),
    quote: z
      .object({
        chainId: z.number(),
        input: z.object({ amount: z.string() }).passthrough(),
        output: z.object({ amount: z.string() }).passthrough(),
        // Assumed field name for the API's own price-impact figure, as a
        // percentage string (e.g. "0.42" = 0.42%) -- if unavailable,
        // exits/swapTx.ts computes its own impact from expected-vs-spot
        // instead of trusting this blindly either way.
        priceImpact: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** Assumed POST /v1/swap response shape (built FROM a specific quote). */
const swapResponseSchema = z
  .object({
    swap: z
      .object({
        to: z.string(),
        data: z.string(),
        value: z.string().optional(),
        chainId: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

export function parseQuoteResponse(body: unknown, amountInRaw: bigint): SwapQuote {
  const parsed = quoteResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new TradingApiMappingError(`Trading API quote response did not match the expected shape: ${parsed.error.message}`, parsed.error);
  }
  const { quote, routing, permitData, allowanceTarget } = parsed.data;

  // Reject UniswapX routing outright -- see TradingApiUnsupportedRoutingError's
  // doc comment. Checked BEFORE anything else in this response is trusted,
  // since a UniswapX response's `quote`/amount fields don't even mean the
  // same thing as a classic quote's.
  if ((UNISWAPX_ROUTING_TYPES as readonly string[]).includes(routing)) {
    throw new TradingApiUnsupportedRoutingError(routing);
  }
  if (!(CLASSIC_ROUTING_TYPES as readonly string[]).includes(routing)) {
    // Neither a known classic type nor a known UniswapX type -- an
    // API change we don't recognize. Never assume "probably fine."
    throw new TradingApiMappingError(`Trading API returned an unrecognized routing type: "${routing}"`);
  }

  // Permit2 was requested disabled (see tradingApiClient.ts) specifically
  // so this integration never needs EIP-712 signing -- if the API still
  // wants a permit, the assumption didn't hold. Fail loudly, don't guess.
  if (permitData !== null && permitData !== undefined) {
    throw new TradingApiPermitRequiredError();
  }

  // Real validation opportunity (not tautological): confirms the API
  // actually quoted the amount we asked for, not a silently different one
  // -- this is the check `validateSwapQuote`'s `echoedAmountInRaw` builds
  // on downstream (see that function's doc comment for the full chain of
  // trust from here through the swap step).
  if (quote.input.amount !== amountInRaw.toString()) {
    throw new TradingApiMappingError(
      `Trading API quoted a different input amount than requested: got ${quote.input.amount}, requested ${amountInRaw.toString()}`,
    );
  }
  let expectedAmountOutRaw: bigint;
  try {
    expectedAmountOutRaw = BigInt(quote.output.amount);
  } catch (err) {
    throw new TradingApiMappingError(`Trading API quote output.amount is not a valid integer string: ${quote.output.amount}`, err);
  }
  const priceImpactPct = quote.priceImpact !== undefined ? Number(quote.priceImpact) / 100 : 0;
  return {
    amountInRaw,
    expectedAmountOutRaw,
    minOutputAmountRaw: 0n, // filled in by the caller once MIN_RECEIVED_PROTECTION_ENABLED is applied
    priceImpactPct: Number.isFinite(priceImpactPct) ? priceImpactPct : 0,
    // Falls back to the swap's own `to` (learned later, from /swap) only if
    // the quote didn't carry an explicit allowanceTarget -- see
    // tradingApiClient.ts's getQuote for how a missing value here is handled.
    allowanceTarget: (allowanceTarget as Address | undefined) ?? null,
  };
}

/**
 * `amountInRaw` here is the CALLER's already-validated `SwapQuote.amountInRaw`
 * (validated once, independently, against the API's own echoed
 * `quote.input.amount` back in `parseQuoteResponse` -- see that function).
 * The assumed /v1/swap response shape doesn't echo the amount a second
 * time (a swap is typically built by passing the whole prior quote object
 * back to the API, not a fresh amount), so `echoedAmountInRaw` here is a
 * PIPELINE self-consistency check, not a second independent API
 * confirmation: `validateSwapQuote` uses it to catch a caller bug (e.g.
 * `buildSwapTx` invoked with a stale/mismatched quote object), not to
 * re-verify the API's own honesty a second time -- that already happened
 * upstream in `parseQuoteResponse`.
 */
export function parseSwapResponse(body: unknown, amountInRaw: bigint, minOutputAmountRaw: bigint): RawSwapTxCandidate {
  const parsed = swapResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new TradingApiMappingError(`Trading API swap response did not match the expected shape: ${parsed.error.message}`, parsed.error);
  }
  const { swap } = parsed.data;
  return {
    to: swap.to,
    data: swap.data,
    value: swap.value ?? '0',
    chainId: swap.chainId,
    echoedAmountInRaw: amountInRaw,
    minOutputAmountRaw,
  };
}

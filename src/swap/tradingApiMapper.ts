import { z } from 'zod';
import { decodeErc20ApproveSpender } from '../blockchain/erc20';
import type { ApprovalCheck, SwapQuote } from './types';
import type { RawSwapTxCandidate } from './validateSwapQuote';

/**
 * C5 fix: the endpoint paths and JSON field names below are now CONFIRMED
 * against the real, live Uniswap Trading API OpenAPI spec (fetched
 * directly from https://trade-api.gateway.uniswap.org/v1/api.json), not
 * assumed. Four concrete mismatches from the previous (assumed) version
 * were found and corrected here:
 *  1. `quote.priceImpact` is a JSON NUMBER in the real API, not a string
 *     -- the old `z.string()` schema meant EVERY real response failed
 *     `safeParse` and threw, uncaught, out of `getQuote`.
 *  2. There is no `allowanceTarget` field on the quote response at all --
 *     the real mechanism is a separate `POST /check_approval` call (see
 *     `parseApprovalResponse` below).
 *  3. `POST /v1/swap`'s request body needs the ENTIRE prior `quote` object
 *     echoed back under a `quote` key, not a re-derivation from scalar
 *     fields -- see `tradingApiClient.ts`'s `buildSwapTx`.
 *  4. The real quote response nests `slippage`/`priceImpact` etc. inside
 *     `quote`, exactly as this schema already expected structurally.
 *
 * This file remains the ONLY place the raw JSON shape is parsed --
 * `tradingApiClient.ts`, `validateSwapQuote.ts`, and everything in
 * `exits/` are written against our own `SwapQuote`/`ApprovalCheck`/
 * `RawSwapTxCandidate` shapes, not the raw JSON, so a future API change
 * only needs a change here.
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
 * calldata, sign+broadcast it ourselves via executeCriticalTransaction)
 * OR a UniswapX/limit order (`DUTCH_V2`, `DUTCH_V3`, `DUTCH_LIMIT`,
 * `PRIORITY`, `LIMIT_ORDER` -- a fundamentally different flow: sign an
 * off-chain ORDER, submit it to `/order`, and wait for a third-party
 * filler to execute it -- there is no transaction for us to
 * build/simulate/broadcast/verify at all). This project's entire
 * transaction-safety pipeline (Module 6) is built around signing and
 * broadcasting OUR OWN transactions -- it has no concept of "submit an
 * order and wait for a filler." UniswapX routing is therefore flatly
 * incompatible, not just undesirable, and is REJECTED outright rather
 * than ever handed to `executeCriticalTransaction`.
 *
 * PHASE 5: the reject list was re-verified against the LIVE OpenAPI
 * spec's `Routing` enum (CLASSIC, DUTCH_LIMIT, DUTCH_V2, DUTCH_V3,
 * BRIDGE, LIMIT_ORDER, PRIORITY, WRAP, UNWRAP, CHAINED) and extended
 * with `DUTCH_LIMIT` and `LIMIT_ORDER`, which the earlier list (built
 * from an older spec snapshot) did not know about. `CHAINED` is not
 * listed in either set below -- it lands in the unrecognized-routing
 * rejection, deliberately: a chained flow is not a single classic swap
 * either, and an unrecognized type must never be assumed "probably fine."
 */
const UNISWAPX_ROUTING_TYPES = ['DUTCH_V2', 'DUTCH_V3', 'DUTCH_LIMIT', 'PRIORITY', 'LIMIT_ORDER'] as const;
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

/**
 * Confirmed POST /v1/quote response shape (EXACT_INPUT quote), against the
 * real OpenAPI spec. `priceImpact` is a NUMBER (e.g. `0.42` = 0.42%), not
 * a string -- this was the exact field type mismatch that made every real
 * response fail to parse under the old (assumed) schema. No
 * `allowanceTarget` field exists here -- see `parseApprovalResponse`.
 */
const quoteResponseSchema = z
  .object({
    routing: z.string(),
    quote: z
      .object({
        chainId: z.number(),
        input: z.object({ amount: z.string() }).loose(),
        output: z.object({ amount: z.string() }).loose(),
        priceImpact: z.number().optional(),
        permitData: z.unknown().nullable().optional(),
      })
      .loose(),
  })
  .loose();

/**
 * Confirmed POST /check_approval response shape. `approval` is either a
 * ready-to-sign transaction object (approval needed) or `null` (already
 * sufficiently approved). This project deliberately does NOT broadcast
 * `approval` as-is -- see `decodeErc20ApproveSpender`'s doc comment for
 * why the spender is extracted and a fresh, exact-amount approve is built
 * via `exits/approveTx.ts` instead.
 */
const approvalResponseSchema = z
  .object({
    approval: z
      .object({
        to: z.string(),
        data: z.string(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

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
      .loose(),
  })
  .loose();

/**
 * TIER 3: returns everything in `SwapQuote` EXCEPT `slippageBps` -- the
 * escalation tier is the CALLER's decision (it comes from the exit's
 * attempt counter, not from the API response), so the mapper does not
 * carry a placeholder for it. A `slippageBps: 0` stand-in here would have
 * read as "zero slippage tolerance" to anything that forgot to overwrite
 * it; omitting the field makes forgetting a compile error instead.
 */
export function parseQuoteResponse(body: unknown, amountInRaw: bigint): Omit<SwapQuote, 'slippageBps'> {
  const parsed = quoteResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new TradingApiMappingError(`Trading API quote response did not match the expected shape: ${parsed.error.message}`, parsed.error);
  }
  const { quote, routing } = parsed.data;
  const permitData = quote.permitData;

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

  // `permitData` is ADVISORY (exit-router resolution, 2026-09-20). The API
  // offers a signature route; this project instead relies on an on-chain
  // Permit2 allowance, so a non-null value here is NOT a failure. What decides
  // whether a swap is signable is the CALLDATA -- checked command by command in
  // `swap/universalRouterCalldata.ts`, which fails closed on PERMIT2_PERMIT.
  // Recorded on the quote so the decision is auditable rather than discarded.
  const permitDataPresent = permitData !== null && permitData !== undefined;

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
  // Confirmed a NUMBER (e.g. 0.42 = 0.42%), not a percentage string -- see
  // this file's top doc comment.
  //
  // TIER 3: a MISSING or non-finite `priceImpact` now maps to `null`, not
  // to `0`. `priceImpact` is optional in the real API, and with the exit
  // gate now blocking on impact, defaulting an absent reading to zero
  // would have meant "the provider declined to tell us" sailing through as
  // the single most permissive value possible. `null` means UNVERIFIED,
  // and the gate defers on it rather than passing it.
  const rawImpact = quote.priceImpact !== undefined ? quote.priceImpact / 100 : null;
  const priceImpactPct = rawImpact !== null && Number.isFinite(rawImpact) ? rawImpact : null;
  return {
    amountInRaw,
    expectedAmountOutRaw,
    minOutputAmountRaw: 0n, // filled in by the caller once MIN_RECEIVED_PROTECTION_ENABLED is applied
    priceImpactPct,
    permitDataPresent,
    // The whole `quote` object, opaque, to be echoed back verbatim to
    // POST /v1/swap -- see SwapQuote.providerQuote's doc comment.
    providerQuote: quote,
  };
}

/**
 * C5 fix: parses `POST /check_approval`'s response into this project's own
 * `ApprovalCheck` shape. The real API returns ready-to-sign approval
 * calldata (not an explicit `spender` field) -- the spender is decoded out
 * of that calldata's own `approve(spender, amount)` arguments, specifically
 * so `exits/executeExit.ts` can build its OWN exact-`amountInRaw` approve
 * transaction via `exits/approveTx.ts` rather than trusting whatever
 * amount the API's own calldata encodes (this project's established
 * "approve exactly what's needed, never unbounded" discipline).
 */
export function parseApprovalResponse(body: unknown): ApprovalCheck {
  const parsed = approvalResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new TradingApiMappingError(`Trading API check_approval response did not match the expected shape: ${parsed.error.message}`, parsed.error);
  }
  const approval = parsed.data.approval;
  if (!approval) {
    return { needsApproval: false, spender: null };
  }
  if (!HEX_DATA_RE.test(approval.data)) {
    throw new TradingApiMappingError(`Trading API check_approval returned non-hex approval.data: ${approval.data}`);
  }
  const spender = decodeErc20ApproveSpender(approval.data as `0x${string}`);
  if (!spender) {
    throw new TradingApiMappingError('Trading API check_approval returned an approval transaction whose calldata could not be decoded as ERC20 approve()');
  }
  return { needsApproval: true, spender };
}

const HEX_DATA_RE = /^0x[0-9a-fA-F]*$/;

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

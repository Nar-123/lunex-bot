import type { Address } from 'viem';
import { config } from '../config';
import { QUOTE_ASSET } from '../config/constants';
import { getExecutorAddress } from '../blockchain/walletClient';
import type { TxRequest } from '../execution/types';
import { parseApprovalResponse, parseQuoteResponse, parseSwapResponse } from './tradingApiMapper';
import { validateSwapQuote } from './validateSwapQuote';
import type { ApprovalCheck, SwapExecutor, SwapQuote } from './types';

/**
 * Restricts routing to classic AMM protocols, excluding UniswapX.
 * PHASE 5: the accepted string values are now CONFIRMED against the live
 * OpenAPI spec -- `ProtocolItems` enum: V2, V3, V4, UNISWAPX,
 * UNISWAPX_V2, UNISWAPX_V3, UNISWAPX_LATEST (previously flagged as a
 * best-effort assumption). Even with this restriction requested, the
 * response's `routing` field is independently re-checked in
 * `tradingApiMapper.ts`'s `parseQuoteResponse` -- a request-side
 * restriction is never assumed to be honored, only verified.
 */
const CLASSIC_ONLY_PROTOCOLS = ['V2', 'V3', 'V4'];

/**
 * PHASE 5: CONFIRMED against the live OpenAPI spec (the documented
 * `x-permit2-disabled` header parameter on POST /quote): "Disables the
 * Permit2 approval flow. When set to `true`, `permitData` is returned as
 * `null` and the header is forwarded to the routing layer for correct gas
 * simulation against the Proxy Universal Router contract. When `false` or
 * omitted, the standard Permit2 approval flow is used." Previously
 * flagged as a best-effort guess. `parseQuoteResponse` still independently
 * verifies `permitData` is actually null and throws loudly if the opt-out
 * did not take effect -- never trusted just because it was requested.
 */
const PERMIT2_DISABLED_HEADER = 'x-permit2-disabled';

/**
 * Uniswap Trading API implementation of `SwapExecutor` -- exits/'s
 * TOKEN->USDG swap leg. Chosen over GMGN specifically because GMGN is
 * confirmed (via reference production code, per review) to only swap out
 * to native ETH, not directly to a stablecoin like USDG -- using it here
 * would silently turn the exit flow's two transactions (remove-liquidity,
 * swap) into three (remove-liquidity, TOKEN->ETH, ETH->USDG), which the
 * failure-state-machine design in `exits/executeExit.ts` is NOT built to
 * handle. Trading API, as a general-purpose router, is expected to support
 * TOKEN->USDG directly in one hop.
 *
 * Returns only UNSIGNED calldata -- this client never signs or broadcasts
 * anything. `exits/swapTx.ts` runs the returned `TxRequest` through
 * `execution/`'s `executeCriticalTransaction`, exactly like every other
 * critical transaction in this project (remove-liquidity included) -- this
 * is what satisfies "must go through Module 6, not called directly."
 *
 * C5/C6 fix: endpoint paths and JSON shape are now CONFIRMED against the
 * real, live Uniswap Trading API OpenAPI spec -- see `tradingApiMapper.ts`'s
 * doc comment for the specific mismatches found and corrected.
 */
export class TradingApiSwapClient implements SwapExecutor {
  constructor(
    private readonly baseUrl: string = config.uniswapTradingApi.baseUrl,
    private readonly apiKey: string = config.uniswapTradingApi.apiKey,
    private readonly walletAddress: Address = getExecutorAddress(),
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [PERMIT2_DISABLED_HEADER]: 'true',
    };
    // API key travels via header, never a query param/URL -- matches this
    // project's existing secrets-via-header-not-argv discipline (see
    // discovery/gmgnCliClient.ts's childEnv()).
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    return headers;
  }

  async getQuote(tokenIn: Address, amountInRaw: bigint, slippageBps: number): Promise<SwapQuote> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/quote`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        tokenInChainId: config.chain.chainId,
        tokenOutChainId: config.chain.chainId,
        tokenIn,
        tokenOut: QUOTE_ASSET.ADDRESS,
        amount: amountInRaw.toString(),
        type: 'EXACT_INPUT',
        swapper: this.walletAddress,
        // Restricts routing to classic AMM protocols -- see
        // CLASSIC_ONLY_PROTOCOLS's doc comment. The response's `routing`
        // is independently re-verified regardless (parseQuoteResponse),
        // this request-side field is never trusted alone to guarantee it.
        protocols: CLASSIC_ONLY_PROTOCOLS,
        // C6 fix + TIER 3 + PHASE 5: the request field is
        // `slippageTolerance` -- a PERCENTAGE number (e.g. 1 = 1%), max two
        // decimal places -- CONFIRMED against the live OpenAPI spec
        // (QuoteRequest.slippageTolerance; the RESPONSE field is the one
        // named `slippage`, ClassicQuote.slippage -- the earlier version of
        // this call sent the request under the response's name, and the API
        // silently ignored the unknown field, quoting at its own default
        // tolerance instead of the caller's ladder tier). C6 first wired
        // slippage up at all; TIER 3 made it always sent; PHASE 5 corrected
        // the field name. An exit swap with no slippage bound is not a
        // safer swap -- it is an unbounded one.
        slippageTolerance: bpsToPercent(slippageBps),
      }),
    });
    if (!res.ok) {
      throw new Error(`Trading API /v1/quote failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body: unknown = await res.json();
    const quote = parseQuoteResponse(body, amountInRaw);
    // The post-hoc balance-delta minimum is derived from the SAME tier
    // that was just sent to the router, so the two can never disagree.
    const minOutputAmountRaw = config.rules.exits.MIN_RECEIVED_PROTECTION_ENABLED
      ? computeMinOutputAmount(quote.expectedAmountOutRaw, slippageBps)
      : 0n;
    return { ...quote, minOutputAmountRaw, slippageBps };
  }

  async checkApproval(tokenIn: Address, amountInRaw: bigint): Promise<ApprovalCheck> {
    const res = await this.fetchFn(`${this.baseUrl}/check_approval`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        chainId: config.chain.chainId,
        walletAddress: this.walletAddress,
        token: tokenIn,
        amount: amountInRaw.toString(),
      }),
    });
    if (!res.ok) {
      throw new Error(`Trading API /check_approval failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body: unknown = await res.json();
    return parseApprovalResponse(body);
  }

  async buildSwapTx(_tokenIn: Address, quote: SwapQuote): Promise<TxRequest> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/swap`, {
      method: 'POST',
      headers: this.headers(),
      // C5 fix: the real API builds a swap FROM the entire prior quote
      // object, not from re-sent scalar fields (tokenIn/amount/etc. --
      // the old request body here) -- confirmed against the live spec.
      // `quote.providerQuote` is the exact, unmodified object `/v1/quote`
      // returned; echoing anything else back is a request the real API
      // does not accept the same way.
      body: JSON.stringify({ quote: quote.providerQuote }),
    });
    if (!res.ok) {
      throw new Error(`Trading API /v1/swap failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body: unknown = await res.json();
    const candidate = parseSwapResponse(body, quote.amountInRaw, quote.minOutputAmountRaw);
    return validateSwapQuote(candidate, {
      amountInRaw: quote.amountInRaw,
      chainId: config.chain.chainId,
      minReceivedRequired: config.rules.exits.MIN_RECEIVED_PROTECTION_ENABLED,
      allowedRouterAddress: config.uniswapTradingApi.allowedRouterAddress,
    });
  }
}

/**
 * TIER 3: the real API's `slippage` request field is a PERCENTAGE number
 * (confirmed against the live OpenAPI spec: e.g. `5.5` = 5.5%), while this
 * project -- following Meridian -- reasons in basis points. One conversion,
 * in one place, so a 100-bps tier can never be sent as "100%".
 */
function bpsToPercent(bps: number): number {
  return bps / 100;
}

/**
 * Post-hoc verification minimum -- defense-in-depth alongside the REAL
 * on-chain bound requested via `slippage` (C6 wired that up; TIER 3 makes
 * it always-on and tier-driven). Derived from the SAME `slippageBps` that
 * was sent to the router, so the router's bound and this check can never
 * silently disagree -- previously both were hardcoded to 1% independently.
 * Only exercised when `EXITS.MIN_RECEIVED_PROTECTION_ENABLED` is true.
 */
function computeMinOutputAmount(expectedAmountOutRaw: bigint, slippageBps: number): bigint {
  const keptBps = BigInt(Math.max(0, 10_000 - Math.round(slippageBps)));
  return (expectedAmountOutRaw * keptBps) / 10_000n;
}

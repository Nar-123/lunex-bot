import type { Address } from 'viem';
import { config } from '../config';
import { QUOTE_ASSET } from '../config/constants';
import { getExecutorAddress } from '../blockchain/walletClient';
import type { TxRequest } from '../execution/types';
import { parseQuoteResponse, parseSwapResponse } from './tradingApiMapper';
import { validateSwapQuote } from './validateSwapQuote';
import type { SwapExecutor, SwapQuote } from './types';

/**
 * Restricts routing to classic AMM protocols, excluding UniswapX --
 * FLAGGED, NOT VERIFIED: the exact accepted string values for the
 * `protocols` request field are a best-effort assumption (no network
 * access from here to check real API docs), isolated to this one
 * constant. Even with this restriction requested, the response's
 * `routing` field is independently re-checked in `tradingApiMapper.ts`'s
 * `parseQuoteResponse` -- a request-side restriction is never assumed to
 * be honored, only verified.
 */
const CLASSIC_ONLY_PROTOCOLS = ['V2', 'V3', 'V4'];

/**
 * FLAGGED, NOT VERIFIED: best-effort guess at a header the API might
 * support for opting out of Permit2 in favor of a plain ERC20 `approve()`
 * flow (see `tradingApiMapper.ts`'s `TradingApiPermitRequiredError` doc
 * comment for why this project needs that opt-out rather than
 * implementing EIP-712 signing). If the real API has no such header, the
 * request-side ask is a harmless no-op -- `parseQuoteResponse` still
 * independently verifies `permitData` is actually null and throws loudly
 * if it isn't, rather than silently proceeding as if the opt-out worked.
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
 * FLAGGED: the exact endpoint paths/JSON shape assumed here are
 * unconfirmed against real API docs (no network access from here) -- see
 * `tradingApiMapper.ts`'s doc comment, which isolates that assumption to
 * one file.
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

  async getQuote(tokenIn: Address, amountInRaw: bigint): Promise<SwapQuote> {
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
      }),
    });
    if (!res.ok) {
      throw new Error(`Trading API /v1/quote failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    const quote = parseQuoteResponse(body, amountInRaw);
    const minOutputAmountRaw = config.rules.exits.MIN_RECEIVED_PROTECTION_ENABLED
      ? computeMinOutputAmount(quote.expectedAmountOutRaw)
      : 0n;
    return { ...quote, minOutputAmountRaw };
  }

  async buildSwapTx(tokenIn: Address, quote: SwapQuote): Promise<TxRequest> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/swap`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        tokenInChainId: config.chain.chainId,
        tokenOutChainId: config.chain.chainId,
        tokenIn,
        tokenOut: QUOTE_ASSET.ADDRESS,
        amount: quote.amountInRaw.toString(),
        type: 'EXACT_INPUT',
        swapper: this.walletAddress,
        protocols: CLASSIC_ONLY_PROTOCOLS,
      }),
    });
    if (!res.ok) {
      throw new Error(`Trading API /v1/swap failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    const candidate = parseSwapResponse(body, quote.amountInRaw, quote.minOutputAmountRaw);
    return validateSwapQuote(candidate, {
      amountInRaw: quote.amountInRaw,
      chainId: config.chain.chainId,
      minReceivedRequired: config.rules.exits.MIN_RECEIVED_PROTECTION_ENABLED,
    });
  }
}

/**
 * Placeholder slippage-based minimum -- only ever exercised when
 * `EXITS.MIN_RECEIVED_PROTECTION_ENABLED` is true, which is OFF by default
 * per spec (same "unlocked/TBD, must not invent a value presented as
 * final" treatment as `capital/decideCapitalAllocation.ts`'s ETH gas
 * reserve). 1% here is a conservative starting point, not a spec value.
 */
function computeMinOutputAmount(expectedAmountOutRaw: bigint): bigint {
  const bps = 9900n; // 99% of expected, i.e. 1% max slippage
  return (expectedAmountOutRaw * bps) / 10000n;
}

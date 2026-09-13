/**
 * PHASE 5 — the `quote` subcommand of `validate-live.ts`. Fetches REAL
 * quotes from the real Trading API for a TOKEN -> USDG swap, once per
 * slippage tier (EXITS.SLIPPAGE_TIERS_BPS = 100/200/300 bps), printing
 * everything the exit decision sees. See `validate-live.ts`'s header for
 * the never-sign/never-broadcast guarantee and the flag gating.
 *
 * What this does NOT do, deliberately: it never calls `/v1/swap` (the
 * endpoint that returns calldata for a specific quote) — the swap step is
 * a different, later validation with its own explicit opt-in, and this
 * phase's contract is quotes only. Router validation therefore exercises
 * `validateSwapQuote` against the CONFIGURED router with a synthetic
 * well-formed candidate, which proves the fail-closed allow-list logic
 * without asking the API to build a transaction.
 */
import { getAddress } from 'viem';
import { config } from './config';
import { getExecutorAddress } from './blockchain/walletClient';
import { TradingApiSwapClient } from './swap/tradingApiClient';
import { validateSwapQuote, SwapQuoteValidationError } from './swap/validateSwapQuote';
import type { RawSwapTxCandidate } from './swap/validateSwapQuote';

function line(char = '─'): string {
  return char.repeat(72);
}

export async function runQuoteValidation(tokenAddressRaw: string, amountInRaw: bigint): Promise<number> {
  const token = getAddress(tokenAddressRaw);
  const wallet = getExecutorAddress();
  const client = new TradingApiSwapClient();

  console.log(line());
  console.log('LUNEX LIVE VALIDATION — QUOTE-ONLY (no sign, no broadcast, no /swap call)');
  console.log(`API base:  ${config.uniswapTradingApi.baseUrl}`);
  console.log(`chainId:   ${config.chain.chainId}`);
  console.log(`wallet:    ${wallet} (swapper field of the quote request — address only)`);
  console.log(`tokenIn:   ${token}`);
  console.log(`tokenOut:  ${config.quoteAsset.ADDRESS} (USDG)`);
  console.log(`amountIn:  ${amountInRaw} raw`);
  console.log(line());
  if (!config.uniswapTradingApi.allowedRouterAddress) {
    console.log('NOTE: UNISWAP_ALLOWED_SWAP_ROUTER_ADDRESS is EMPTY — the router/caldara');
    console.log('      section is skipped (validateSwapQuote fails closed in production;');
    console.log('      that safe behaviour is not overridden here).');
    console.log();
  }

  let failures = 0;
  const tiers = config.rules.exits.SLIPPAGE_TIERS_BPS;
  for (const bps of tiers) {
    try {
      const quote = await client.getQuote(token, amountInRaw, bps);
      const provider = quote.providerQuote as {
        output?: { amount?: string; minimumAmount?: string };
        slippage?: number;
        priceImpact?: number;
      };
      const apiMinimum = provider.output?.minimumAmount;
      const apiSlippageEcho = provider.slippage;
      console.log(`  tier ${bps} bps (requested slippageTolerance ${(bps / 100).toFixed(2)}%)`);
      console.log(`    input amount:            ${quote.amountInRaw}`);
      console.log(`    expected output (raw):   ${quote.expectedAmountOutRaw}`);
      console.log(
        `    priceImpact (API):       ${
          quote.priceImpactPct === null ? 'UNAVAILABLE (null — the exit gate defers on this)' : `${(quote.priceImpactPct * 100).toFixed(4)}%`
        }`,
      );
      console.log(
        `    minOutputAmountRaw (ours, ${
          config.rules.exits.MIN_RECEIVED_PROTECTION_ENABLED ? 'post-hoc check ON' : 'post-hoc check OFF'
        }): ${quote.minOutputAmountRaw}`,
      );
      console.log(`    API minimumAmount:       ${apiMinimum ?? 'not reported'}`);
      console.log(`    API slippage echo:       ${apiSlippageEcho !== undefined ? `${apiSlippageEcho} (tolerance as %)` : 'not reported'}`);

      // The approval check is a READ (POST /check_approval): it tells us
      // which spender the API would approve toward, without building,
      // signing, or sending anything.
      try {
        const approval = await client.checkApproval(token, amountInRaw);
        console.log(`    approval needed:         ${approval.needsApproval ? `yes, spender ${approval.spender}` : 'no'}`);
      } catch (err) {
        failures++;
        console.log(`    approval check FAILED:   ${String(err)}`);
      }
      console.log();
    } catch (err) {
      failures++;
      console.log(`  tier ${bps} bps: QUOTE FAILED`);
      console.log(`    ${err instanceof Error ? err.message : String(err)}`);
      console.log();
    }
  }

  // Validate the router config the way the swap path would — fail-closed
  // proof on a synthetic well-formed candidate (see header: /v1/swap is
  // never called in this phase).
  if (config.uniswapTradingApi.allowedRouterAddress) {
    const candidate: RawSwapTxCandidate = {
      to: config.uniswapTradingApi.allowedRouterAddress,
      data: '0x' + 'ab'.repeat(4),
      value: '0',
      chainId: config.chain.chainId,
      echoedAmountInRaw: amountInRaw,
      minOutputAmountRaw: 0n,
    };
    try {
      validateSwapQuote(candidate, {
        amountInRaw,
        chainId: config.chain.chainId,
        minReceivedRequired: config.rules.exits.MIN_RECEIVED_PROTECTION_ENABLED,
        allowedRouterAddress: config.uniswapTradingApi.allowedRouterAddress,
      });
      console.log(`  router allow-list: configured router ${config.uniswapTradingApi.allowedRouterAddress} passes the exit flow's own validation`);
    } catch (err) {
      if (err instanceof SwapQuoteValidationError) {
        failures++;
        console.log(`  router allow-list: FAIL CLOSED — ${err.message}`);
      }
    }
  } else {
    console.log('  router allow-list: EMPTY — every swap would be rejected (fail-closed). This is the correct safe default until the real router address is confirmed.');
  }

  console.log(line());
  console.log(`Quote-only validation done — ${failures} failure(s). NOTHING was signed or broadcast; /v1/swap was never called.`);
  return failures === 0 ? 0 : 1;
}

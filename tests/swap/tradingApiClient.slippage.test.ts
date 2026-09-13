import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

/**
 * C6 regression, isolated in its OWN file: `config` is frozen at first
 * import (see `src/config/index.ts`), so the ENABLED state of
 * `EXIT_MIN_RECEIVED_PROTECTION_ENABLED` must be set via `process.env`
 * BEFORE anything imports `config` -- vitest gives each test FILE its own
 * isolated module registry by default, so this is safe to do here without
 * affecting `tradingApiClient.test.ts` (which relies on the default OFF
 * state).
 */
process.env.EXIT_MIN_RECEIVED_PROTECTION_ENABLED = 'true';

const WALLET = '0x9999999999999999999999999999999999999999' as Address;
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response;
}

describe('TradingApiSwapClient.getQuote -- C6: slippage IS sent to the real API when MIN_RECEIVED_PROTECTION_ENABLED is on', () => {
  it('sends a real, non-zero `slippageTolerance` percentage on the quote request -- the router bakes it into the returned calldata, not just a post-hoc check', async () => {
    const { TradingApiSwapClient } = await import('../../src/swap/tradingApiClient');
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        routing: 'CLASSIC',
        quote: { chainId: 4663, input: { amount: '500' }, output: { amount: '490' }, priceImpact: 0.1, permitData: null },
      }),
    );
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    const quote = await client.getQuote(TOKEN, 500n, 200);

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // PHASE 5: the request field is `slippageTolerance` (live OpenAPI
    // QuoteRequest), NOT `slippage` (that's the RESPONSE field's name).
    expect(typeof body.slippageTolerance).toBe('number');
    expect(body.slippageTolerance).toBe(2); // the 200-bps tier passed in, as a percentage
    expect(body.slippage).toBeUndefined(); // the wrong-name field is never sent

    // TIER 3: with the toggle ON, the post-hoc balance-delta minimum is
    // derived from the SAME tier that was sent to the router -- 490 * (1 -
    // 2%) = 480 -- so the on-chain bound and the verification bound can
    // never silently disagree.
    expect(quote.minOutputAmountRaw).toBe(480n);
  });
});

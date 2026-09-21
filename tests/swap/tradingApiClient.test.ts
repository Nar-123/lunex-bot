import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { TradingApiSwapClient } from '../../src/swap/tradingApiClient';
import { TradingApiUnsupportedRoutingError } from '../../src/swap/tradingApiMapper';
import { urExecuteCalldata } from './urCalldataFixture';

const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;
/** A real Universal Router command batch selling 500 of TOKEN to WALLET -- what the Permit2-enabled API returns. */
const UR_DATA = urExecuteCalldata({ recipient: WALLET, tokenIn: TOKEN, amountIn: 500n });

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

/** Matches the CONFIRMED real API shape (fetched from the live OpenAPI spec) -- `priceImpact` is a number, `permitData` nests inside `quote`, there is no `allowanceTarget` anywhere. */
function classicQuoteBody({ routing = 'CLASSIC', quotePatch = {} }: { routing?: string; quotePatch?: Record<string, unknown> } = {}) {
  return {
    routing,
    quote: { chainId: 4663, input: { amount: '500' }, output: { amount: '490' }, priceImpact: 0.1, permitData: null, ...quotePatch },
  };
}

describe('TradingApiSwapClient.getQuote', () => {
  it('sends `protocols` restricted to classic AMM routing, and does NOT send x-permit2-disabled (exit-router resolution)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody()));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    await client.getQuote(TOKEN, 500n, 100);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/quote');
    const body = JSON.parse(init.body as string);
    expect(body.protocols).toEqual(['V2', 'V3', 'V4']);
    expect(body.protocols).not.toContain('DUTCH_V2');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-permit2-disabled']).toBeUndefined();
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('x-permit2-disabled');
    // the router version is PINNED -- the API default moved to an unallowlisted router overnight
    expect(headers['x-universal-router-version']).toBe('2.1.1');
  });

  it('sends the API key as a header, never in the URL or body', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody()));
    const client = new TradingApiSwapClient('https://api.test', 'secret-key-123', WALLET, fetchFn);

    await client.getQuote(TOKEN, 500n, 100);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('secret-key-123');
    expect(init.body as string).not.toContain('secret-key-123');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('secret-key-123');
  });

  it('rejects with TradingApiUnsupportedRoutingError when the response still comes back as UniswapX routing, despite the restriction requested', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody({ routing: 'DUTCH_V2' })));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    await expect(client.getQuote(TOKEN, 500n, 100)).rejects.toThrow(TradingApiUnsupportedRoutingError);
  });

  it('PHASE 5: rejects the live-spec routing enum\'s other UniswapX/limit values too (DUTCH_LIMIT, LIMIT_ORDER, DUTCH_V3, PRIORITY) -- not just the older list', async () => {
    // The live OpenAPI Routing enum contains DUTCH_LIMIT and LIMIT_ORDER,
    // which the pre-PHASE-5 reject list did not know about. A limit/dutch
    // order is the same "sign an off-chain order, wait for a filler" flow
    // this pipeline cannot execute -- rejected for the same reason.
    for (const routing of ['DUTCH_LIMIT', 'LIMIT_ORDER', 'DUTCH_V3', 'PRIORITY'] as const) {
      const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody({ routing })));
      const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);
      await expect(client.getQuote(TOKEN, 500n, 100)).rejects.toThrow(TradingApiUnsupportedRoutingError);
    }
  });

  it('PHASE 5: an unrecognized routing value (e.g. the live spec\'s CHAINED) is still rejected as unrecognized, never assumed "probably fine"', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody({ routing: 'CHAINED' })));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    await expect(client.getQuote(TOKEN, 500n, 100)).rejects.toThrow(/unrecognized routing type/);
  });

  it('a quote carrying permitData is accepted and flagged -- permitData is advisory, the calldata is what is enforced', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody({ quotePatch: { permitData: { some: 'payload' } } })));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    const q = await client.getQuote(TOKEN, 500n, 100);
    expect(q.permitDataPresent).toBe(true);
  });

  it('C5: priceImpact is parsed as a real NUMBER (the confirmed API type), not a string', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody({ quotePatch: { priceImpact: 0.42 } })));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    const quote = await client.getQuote(TOKEN, 500n, 100);
    expect(quote.priceImpactPct).toBeCloseTo(0.0042, 6); // 0.42% -> 0.0042 fraction
  });

  it('C5: the returned SwapQuote carries the whole raw provider quote object, for echoing back to /v1/swap', async () => {
    const body = classicQuoteBody();
    const fetchFn = vi.fn(async () => jsonResponse(body));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    const quote = await client.getQuote(TOKEN, 500n, 100);
    expect(quote.providerQuote).toEqual(body.quote);
  });

  it('PHASE 5: the caller-supplied ladder tier is ALWAYS sent as the real `slippageTolerance` request field, converted bps -> percent', async () => {
    // Supersedes the C6-era assertion that slippage was omitted unless
    // MIN_RECEIVED_PROTECTION_ENABLED was on. That toggle governs only the
    // POST-HOC balance-delta minimum; the request-side bound is what the
    // router actually bakes into the calldata, and an exit swap sent with
    // no bound at all is an unbounded swap, not a safer one. It is now
    // unconditional and driven by the escalation tier the caller passed.
    //
    // The FIELD NAME is `slippageTolerance` per the LIVE OpenAPI spec
    // (QuoteRequest.slippageTolerance) -- the response field is the one
    // named `slippage` (ClassicQuote.slippage). Sending the request under
    // the response's name made the API silently ignore it and quote at its
    // own default tolerance -- caught in PHASE 5's contract verification.
    const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody()));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);
    await client.getQuote(TOKEN, 500n, 100);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.slippageTolerance).toBe(1); // 100 bps -> 1 percent, NOT 100
    expect(body.slippage).toBeUndefined(); // the old (wrong) field name is gone
  });

  it('PHASE 5: each escalation tier is forwarded verbatim under slippageTolerance -- 100/200/300 bps become 1/2/3 percent, never a hardcoded constant', async () => {
    for (const [bps, pct] of [[100, 1], [200, 2], [300, 3]] as const) {
      const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody()));
      const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);
      const quote = await client.getQuote(TOKEN, 500n, bps);
      const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(init.body as string).slippageTolerance).toBe(pct);
      // and the returned quote reports back which tier produced it
      expect(quote.slippageBps).toBe(bps);
    }
  });

  it('throws a clear error on a non-ok HTTP response, never silently returning a zero/default quote', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'rate limited' }, false));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    await expect(client.getQuote(TOKEN, 500n, 100)).rejects.toThrow(/HTTP 500/);
  });
});

describe('TradingApiSwapClient.checkApproval', () => {
  it('calls POST /check_approval and reports no approval needed when `approval` is null', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ approval: null }));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    const result = await client.checkApproval(TOKEN, 500n);

    expect(result).toEqual({ needsApproval: false, spender: null });
    const [url] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/check_approval');
  });

  it('decodes the spender from the returned approval calldata when approval IS needed', async () => {
    const spender = '0x5555555555555555555555555555555555555555';
    // approve(spender, amount) calldata -- selector 0x095ea7b3 + 32-byte spender + 32-byte amount.
    const data = `0x095ea7b3000000000000000000000000${spender.slice(2)}${'f'.repeat(64)}`;
    const fetchFn = vi.fn(async () => jsonResponse({ approval: { to: TOKEN, data } }));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    const result = await client.checkApproval(TOKEN, 500n);
    expect(result.needsApproval).toBe(true);
    expect(result.spender?.toLowerCase()).toBe(spender.toLowerCase());
  });
});

describe('router version pinning (exit-router resolution, 2026-09-21)', () => {
  it('every Trading API call pins x-universal-router-version=2.1.1 -- quote, check_approval and swap', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.endsWith('/v1/quote') ? jsonResponse(classicQuoteBody())
        : url.endsWith('/check_approval') ? jsonResponse({ approval: null })
        : jsonResponse({ swap: { to: '0x1111111111111111111111111111111111111111', data: UR_DATA, value: '0', chainId: 4663 } }));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn as never);
    const q = await client.getQuote(TOKEN, 500n, 100);
    await client.checkApproval(TOKEN, 500n);
    await client.buildSwapTx(TOKEN, q);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    for (const call of fetchFn.mock.calls) {
      const headers = (call as unknown as [string, RequestInit])[1].headers as Record<string, string>;
      expect(headers['x-universal-router-version']).toBe('2.1.1');
      expect(headers['x-permit2-disabled']).toBeUndefined();
    }
  });
});

describe('TradingApiSwapClient.buildSwapTx', () => {
  it('C5: sends the whole prior quote object under `quote`, never re-derived scalar fields', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ swap: { to: '0x1111111111111111111111111111111111111111', data: UR_DATA, value: '0', chainId: 4663 } }),
    );
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);
    const providerQuote = { chainId: 4663, input: { amount: '500' }, output: { amount: '490' } };
    const quote = { amountInRaw: 500n, expectedAmountOutRaw: 490n, minOutputAmountRaw: 0n, priceImpactPct: 0.001, providerQuote, slippageBps: 100 };

    await client.buildSwapTx(TOKEN, quote);

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ quote: providerQuote });
    expect(body.tokenIn).toBeUndefined(); // never re-sent as a scalar field
  });

  it('returns validated calldata built for the exact requested amount', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ swap: { to: '0x1111111111111111111111111111111111111111', data: UR_DATA, value: '0', chainId: 4663 } }),
    );
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);
    const quote = { amountInRaw: 500n, expectedAmountOutRaw: 490n, minOutputAmountRaw: 0n, priceImpactPct: 0.001, providerQuote: { fake: true }, slippageBps: 100 };

    const tx = await client.buildSwapTx(TOKEN, quote);
    expect(tx).toEqual({ to: '0x1111111111111111111111111111111111111111', data: UR_DATA, value: 0n });
  });
});

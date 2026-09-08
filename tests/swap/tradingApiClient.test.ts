import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { TradingApiSwapClient } from '../../src/swap/tradingApiClient';
import { TradingApiUnsupportedRoutingError, TradingApiPermitRequiredError } from '../../src/swap/tradingApiMapper';

const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const WALLET = '0x9999999999999999999999999999999999999999' as Address;

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function classicQuoteBody(overrides: Record<string, unknown> = {}) {
  return {
    routing: 'CLASSIC',
    permitData: null,
    allowanceTarget: '0x3333333333333333333333333333333333333333',
    quote: { chainId: 4663, input: { amount: '500' }, output: { amount: '490' }, priceImpact: '0.1' },
    ...overrides,
  };
}

describe('TradingApiSwapClient.getQuote', () => {
  it('sends `protocols` restricted to classic AMM routing, and the permit2-disable header, on the quote request', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody()));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    await client.getQuote(TOKEN, 500n);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/quote');
    const body = JSON.parse(init.body as string);
    expect(body.protocols).toEqual(['V2', 'V3', 'V4']);
    expect(body.protocols).not.toContain('DUTCH_V2');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-permit2-disabled']).toBe('true');
  });

  it('sends the API key as a header, never in the URL or body', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody()));
    const client = new TradingApiSwapClient('https://api.test', 'secret-key-123', WALLET, fetchFn);

    await client.getQuote(TOKEN, 500n);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('secret-key-123');
    expect(init.body as string).not.toContain('secret-key-123');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('secret-key-123');
  });

  it('rejects with TradingApiUnsupportedRoutingError when the response still comes back as UniswapX routing, despite the restriction requested', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody({ routing: 'DUTCH_V2' })));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    await expect(client.getQuote(TOKEN, 500n)).rejects.toThrow(TradingApiUnsupportedRoutingError);
  });

  it('rejects with TradingApiPermitRequiredError when the response still carries permitData despite the opt-out header', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody({ permitData: { some: 'payload' } })));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    await expect(client.getQuote(TOKEN, 500n)).rejects.toThrow(TradingApiPermitRequiredError);
  });

  it('surfaces the allowanceTarget from the quote response on the returned SwapQuote', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(classicQuoteBody({ allowanceTarget: '0x4444444444444444444444444444444444444444' })));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    const quote = await client.getQuote(TOKEN, 500n);
    expect(quote.allowanceTarget).toBe('0x4444444444444444444444444444444444444444');
  });

  it('throws a clear error on a non-ok HTTP response, never silently returning a zero/default quote', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'rate limited' }, false));
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);

    await expect(client.getQuote(TOKEN, 500n)).rejects.toThrow(/HTTP 500/);
  });
});

describe('TradingApiSwapClient.buildSwapTx', () => {
  it('sends `protocols` restricted to classic AMM routing on the swap request too', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ swap: { to: '0x1111111111111111111111111111111111111111', data: '0xaabbccdd', value: '0', chainId: 4663 } }),
    );
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);
    const quote = { amountInRaw: 500n, expectedAmountOutRaw: 490n, minOutputAmountRaw: 0n, priceImpactPct: 0.001, allowanceTarget: null };

    await client.buildSwapTx(TOKEN, quote);

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.protocols).toEqual(['V2', 'V3', 'V4']);
  });

  it('returns validated calldata built for the exact requested amount', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ swap: { to: '0x1111111111111111111111111111111111111111', data: '0xaabbccdd', value: '0', chainId: 4663 } }),
    );
    const client = new TradingApiSwapClient('https://api.test', '', WALLET, fetchFn);
    const quote = { amountInRaw: 500n, expectedAmountOutRaw: 490n, minOutputAmountRaw: 0n, priceImpactPct: 0.001, allowanceTarget: null };

    const tx = await client.buildSwapTx(TOKEN, quote);
    expect(tx).toEqual({ to: '0x1111111111111111111111111111111111111111', data: '0xaabbccdd', value: 0n });
  });
});

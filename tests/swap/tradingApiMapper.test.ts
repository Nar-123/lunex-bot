import { describe, expect, it } from 'vitest';
import {
  parseApprovalResponse,
  parseQuoteResponse,
  parseSwapResponse,
  TradingApiMappingError,
  TradingApiPermitRequiredError,
  TradingApiUnsupportedRoutingError,
} from '../../src/swap/tradingApiMapper';

/**
 * C5 fix: this fixture now matches the CONFIRMED real API shape (fetched
 * directly from the live OpenAPI spec at
 * https://trade-api.gateway.uniswap.org/v1/api.json), not an assumption --
 * `priceImpact` is a NUMBER, `permitData` nests INSIDE `quote` (not at the
 * top level), and there is no `allowanceTarget` field anywhere in the
 * response (see `parseApprovalResponse`'s tests below for the real
 * mechanism, `POST /check_approval`).
 */
describe('parseQuoteResponse', () => {
  const validBody = {
    routing: 'CLASSIC',
    quote: {
      chainId: 4663,
      input: { amount: '500' },
      output: { amount: '490' },
      priceImpact: 0.42,
      permitData: null,
    },
  };

  it('maps a well-formed CLASSIC-routing response correctly, including converting priceImpact from a percentage NUMBER to a fraction, and carries the raw quote object through as providerQuote', () => {
    const quote = parseQuoteResponse(validBody, 500n);
    expect(quote).toEqual({
      amountInRaw: 500n,
      expectedAmountOutRaw: 490n,
      minOutputAmountRaw: 0n,
      priceImpactPct: 0.0042,
      providerQuote: validBody.quote,
    });
  });

  it.each(['WRAP', 'UNWRAP', 'BRIDGE'])('accepts routing type %s (normal calldata flow, not UniswapX)', (routing) => {
    expect(() => parseQuoteResponse({ ...validBody, routing }, 500n)).not.toThrow();
  });

  it('TIER 3: an ABSENT priceImpact maps to null, NOT to 0 -- never throws, but never invents the most permissive possible reading either', () => {
    // Supersedes the pre-TIER-3 `-> 0` default. `priceImpact` is optional
    // in the real API, and now that the exit gate genuinely blocks on
    // impact, "the provider declined to tell us" defaulting to zero would
    // have been the single most dangerous value to pick. `null` means
    // UNVERIFIED and the gate defers on it (proven in executeExit.test.ts).
    const { priceImpact, ...withoutImpact } = validBody.quote;
    void priceImpact;
    const quote = parseQuoteResponse({ ...validBody, quote: withoutImpact }, 500n);
    expect(quote.priceImpactPct).toBeNull();
  });

  it('TIER 3: a non-finite priceImpact (NaN/Infinity) is REJECTED loudly at the schema, never passed through as a number', () => {
    // Verified empirically rather than assumed: the zod `number()` schema
    // rejects both before the mapping code is even reached, so these
    // surface as a TradingApiMappingError (a loud, definitive rejection)
    // rather than as a silent value. The `Number.isFinite` guard further
    // down `parseQuoteResponse` is defence-in-depth behind this.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseQuoteResponse({ ...validBody, quote: { ...validBody.quote, priceImpact: bad } }, 500n)).toThrow(TradingApiMappingError);
    }
  });

  it('throws TradingApiMappingError when the response does not match the expected shape at all', () => {
    expect(() => parseQuoteResponse({ notAQuote: true }, 500n)).toThrow(TradingApiMappingError);
  });

  it('throws when the API quoted a different input amount than requested -- a real validation, not tautological', () => {
    expect(() => parseQuoteResponse(validBody, 999n)).toThrow(/quoted a different input amount/);
  });

  it('throws when output.amount is not a valid integer string', () => {
    const bad = { ...validBody, quote: { ...validBody.quote, output: { amount: 'not-a-number' } } };
    expect(() => parseQuoteResponse(bad, 500n)).toThrow(TradingApiMappingError);
  });

  it('rejects a priceImpact sent as a STRING (the old, wrong assumed shape) -- proves the schema genuinely enforces the confirmed number type', () => {
    const bad = { ...validBody, quote: { ...validBody.quote, priceImpact: '0.42' } };
    expect(() => parseQuoteResponse(bad, 500n)).toThrow(TradingApiMappingError);
  });

  describe('routing restriction (protocols request field is restricted to classic AMM routing, but the response is independently re-verified regardless)', () => {
    it.each(['DUTCH_V2', 'DUTCH_V3', 'PRIORITY'])(
      'rejects UniswapX routing type %s with a distinct, clear error -- never processed as ordinary calldata',
      (routing) => {
        expect(() => parseQuoteResponse({ ...validBody, routing }, 500n)).toThrow(TradingApiUnsupportedRoutingError);
      },
    );

    it('the UniswapX rejection error names the offending routing type', () => {
      try {
        parseQuoteResponse({ ...validBody, routing: 'DUTCH_V2' }, 500n);
        throw new Error('expected parseQuoteResponse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TradingApiUnsupportedRoutingError);
        expect((err as TradingApiUnsupportedRoutingError).routing).toBe('DUTCH_V2');
      }
    });

    it('rejects an unrecognized routing type (neither known classic nor known UniswapX) rather than assuming it is safe', () => {
      expect(() => parseQuoteResponse({ ...validBody, routing: 'SOME_NEW_TYPE' }, 500n)).toThrow(TradingApiMappingError);
      expect(() => parseQuoteResponse({ ...validBody, routing: 'SOME_NEW_TYPE' }, 500n)).not.toThrow(TradingApiUnsupportedRoutingError);
    });
  });

  describe('Permit2 opt-out verification (never falls back to guessing/signing if the API still wants a permit)', () => {
    it('accepts a response with quote.permitData explicitly null', () => {
      expect(() => parseQuoteResponse({ ...validBody, quote: { ...validBody.quote, permitData: null } }, 500n)).not.toThrow();
    });

    it('accepts a response that omits quote.permitData entirely', () => {
      const { permitData, ...withoutPermit } = validBody.quote;
      void permitData;
      expect(() => parseQuoteResponse({ ...validBody, quote: withoutPermit }, 500n)).not.toThrow();
    });

    it('throws TradingApiPermitRequiredError when the API still returns non-null quote.permitData despite the opt-out request', () => {
      const withPermit = { ...validBody, quote: { ...validBody.quote, permitData: { some: 'eip712-payload' } } };
      expect(() => parseQuoteResponse(withPermit, 500n)).toThrow(TradingApiPermitRequiredError);
    });

    it('does not silently attempt EIP-712 signing or otherwise proceed when permitData is present -- confirmed by the throw itself carrying no signed data', () => {
      let caught: unknown;
      try {
        parseQuoteResponse({ ...validBody, quote: { ...validBody.quote, permitData: {} } }, 500n);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TradingApiPermitRequiredError);
    });
  });
});

describe('parseSwapResponse', () => {
  const validBody = {
    swap: {
      to: '0x1111111111111111111111111111111111111111',
      data: '0xabcdef12',
      value: '0',
      chainId: 4663,
    },
  };

  it('maps a well-formed response, carrying through the caller-supplied amountInRaw/minOutputAmountRaw', () => {
    const candidate = parseSwapResponse(validBody, 500n, 100n);
    expect(candidate).toEqual({
      to: '0x1111111111111111111111111111111111111111',
      data: '0xabcdef12',
      value: '0',
      chainId: 4663,
      echoedAmountInRaw: 500n,
      minOutputAmountRaw: 100n,
    });
  });

  it('defaults value to "0" when absent', () => {
    const { value, ...withoutValue } = validBody.swap;
    void value;
    const candidate = parseSwapResponse({ swap: withoutValue }, 500n, 0n);
    expect(candidate.value).toBe('0');
  });

  it('throws TradingApiMappingError when the response does not match the expected shape', () => {
    expect(() => parseSwapResponse({ notASwap: true }, 500n, 0n)).toThrow(TradingApiMappingError);
  });
});

describe('parseApprovalResponse -- C5: the real POST /check_approval mechanism replacing the nonexistent allowanceTarget field', () => {
  it('reports no approval needed when `approval` is null', () => {
    expect(parseApprovalResponse({ approval: null })).toEqual({ needsApproval: false, spender: null });
  });

  it('reports no approval needed when `approval` is omitted entirely', () => {
    expect(parseApprovalResponse({})).toEqual({ needsApproval: false, spender: null });
  });

  it('decodes the spender from real ERC20 approve() calldata when approval IS needed', () => {
    const spender = '0x5555555555555555555555555555555555555555';
    const data = `0x095ea7b3000000000000000000000000${spender.slice(2)}${'f'.repeat(64)}`;
    const result = parseApprovalResponse({ approval: { to: '0x0000000000000000000000000000000000000002', data } });
    expect(result.needsApproval).toBe(true);
    expect(result.spender?.toLowerCase()).toBe(spender.toLowerCase());
  });

  it('throws TradingApiMappingError when approval.data cannot be decoded as ERC20 approve()', () => {
    expect(() => parseApprovalResponse({ approval: { to: '0x0000000000000000000000000000000000000002', data: '0xdeadbeef' } })).toThrow(
      TradingApiMappingError,
    );
  });

  it('throws TradingApiMappingError when the response does not match the expected shape', () => {
    expect(() => parseApprovalResponse({ approval: { to: 123 } })).toThrow(TradingApiMappingError);
  });
});

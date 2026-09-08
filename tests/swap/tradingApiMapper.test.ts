import { describe, expect, it } from 'vitest';
import {
  parseQuoteResponse,
  parseSwapResponse,
  TradingApiMappingError,
  TradingApiPermitRequiredError,
  TradingApiUnsupportedRoutingError,
} from '../../src/swap/tradingApiMapper';

describe('parseQuoteResponse', () => {
  const validBody = {
    routing: 'CLASSIC',
    permitData: null,
    allowanceTarget: '0x3333333333333333333333333333333333333333',
    quote: {
      chainId: 4663,
      input: { amount: '500' },
      output: { amount: '490' },
      priceImpact: '0.42',
    },
  };

  it('maps a well-formed CLASSIC-routing response correctly, including converting priceImpact from a percentage string to a fraction', () => {
    const quote = parseQuoteResponse(validBody, 500n);
    expect(quote).toEqual({
      amountInRaw: 500n,
      expectedAmountOutRaw: 490n,
      minOutputAmountRaw: 0n,
      priceImpactPct: 0.0042,
      allowanceTarget: '0x3333333333333333333333333333333333333333',
    });
  });

  it.each(['WRAP', 'UNWRAP', 'BRIDGE'])('accepts routing type %s (normal calldata flow, not UniswapX)', (routing) => {
    expect(() => parseQuoteResponse({ ...validBody, routing }, 500n)).not.toThrow();
  });

  it('allowanceTarget is null when the response does not carry one', () => {
    const { allowanceTarget, ...withoutTarget } = validBody;
    void allowanceTarget;
    const quote = parseQuoteResponse(withoutTarget, 500n);
    expect(quote.allowanceTarget).toBeNull();
  });

  it('defaults priceImpactPct to 0 when the field is absent (never throws for a missing optional field)', () => {
    const { priceImpact, ...withoutImpact } = validBody.quote;
    void priceImpact;
    const quote = parseQuoteResponse({ ...validBody, quote: withoutImpact }, 500n);
    expect(quote.priceImpactPct).toBe(0);
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
    it('accepts a response with permitData explicitly null', () => {
      expect(() => parseQuoteResponse({ ...validBody, permitData: null }, 500n)).not.toThrow();
    });

    it('accepts a response that omits permitData entirely', () => {
      const { permitData, ...withoutPermit } = validBody;
      void permitData;
      expect(() => parseQuoteResponse(withoutPermit, 500n)).not.toThrow();
    });

    it('throws TradingApiPermitRequiredError when the API still returns non-null permitData despite the opt-out request', () => {
      expect(() => parseQuoteResponse({ ...validBody, permitData: { some: 'eip712-payload' } }, 500n)).toThrow(TradingApiPermitRequiredError);
    });

    it('does not silently attempt EIP-712 signing or otherwise proceed when permitData is present -- confirmed by the throw itself carrying no signed data', () => {
      let caught: unknown;
      try {
        parseQuoteResponse({ ...validBody, permitData: {} }, 500n);
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

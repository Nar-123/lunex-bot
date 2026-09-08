import { describe, expect, it } from 'vitest';
import { validateSwapQuote, SwapQuoteValidationError } from '../../src/swap/validateSwapQuote';
import type { RawSwapTxCandidate } from '../../src/swap/validateSwapQuote';

const VALID: RawSwapTxCandidate = {
  to: '0x1111111111111111111111111111111111111111',
  data: '0xabcdef12',
  value: '0',
  chainId: 4663,
  echoedAmountInRaw: 500n,
  minOutputAmountRaw: 0n,
};
const EXPECTED = { amountInRaw: 500n, chainId: 4663, minReceivedRequired: false };

describe('validateSwapQuote -- structural validation before trusting external swap calldata', () => {
  it('accepts a well-formed candidate and returns a clean TxRequest', () => {
    const tx = validateSwapQuote(VALID, EXPECTED);
    expect(tx).toEqual({ to: VALID.to, data: VALID.data, value: 0n });
  });

  it('rejects a chainId mismatch', () => {
    expect(() => validateSwapQuote({ ...VALID, chainId: 1 }, EXPECTED)).toThrow(SwapQuoteValidationError);
  });

  it('rejects a malformed "to" address', () => {
    expect(() => validateSwapQuote({ ...VALID, to: '0xnotanaddress' }, EXPECTED)).toThrow(/not a well-formed EVM address/);
  });

  it('rejects a "to" that is too short', () => {
    expect(() => validateSwapQuote({ ...VALID, to: '0x1234' }, EXPECTED)).toThrow(SwapQuoteValidationError);
  });

  it('rejects malformed "data" (not hex)', () => {
    expect(() => validateSwapQuote({ ...VALID, data: '0xzz' }, EXPECTED)).toThrow(/not well-formed calldata/);
  });

  it('rejects "data" shorter than a 4-byte function selector', () => {
    expect(() => validateSwapQuote({ ...VALID, data: '0xab' }, EXPECTED)).toThrow(SwapQuoteValidationError);
  });

  it('accepts "data" at exactly the minimum length (4-byte selector, no args)', () => {
    expect(() => validateSwapQuote({ ...VALID, data: '0xaabbccdd' }, EXPECTED)).not.toThrow();
  });

  it('rejects an amount-in mismatch -- the API/pipeline built calldata for a different amount than requested', () => {
    expect(() => validateSwapQuote({ ...VALID, echoedAmountInRaw: 999n }, EXPECTED)).toThrow(/amount-in mismatch/);
  });

  it('rejects a zero minOutputAmountRaw when minimum-received protection is required', () => {
    expect(() => validateSwapQuote(VALID, { ...EXPECTED, minReceivedRequired: true })).toThrow(/minOutputAmountRaw/);
  });

  it('accepts a zero minOutputAmountRaw when protection is NOT required (the OFF/default spec state)', () => {
    expect(() => validateSwapQuote(VALID, { ...EXPECTED, minReceivedRequired: false })).not.toThrow();
  });

  it('accepts a nonzero minOutputAmountRaw when protection is required', () => {
    expect(() => validateSwapQuote({ ...VALID, minOutputAmountRaw: 100n }, { ...EXPECTED, minReceivedRequired: true })).not.toThrow();
  });

  it('rejects an unparseable "value"', () => {
    expect(() => validateSwapQuote({ ...VALID, value: 'not-a-number' }, EXPECTED)).toThrow(/"value" is not a valid integer/);
  });

  it('parses a nonzero "value" correctly', () => {
    const tx = validateSwapQuote({ ...VALID, value: '1000000000000000000' }, EXPECTED);
    expect(tx.value).toBe(1_000_000_000_000_000_000n);
  });
});

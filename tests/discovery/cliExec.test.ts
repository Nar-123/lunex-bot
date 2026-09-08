import { describe, expect, it } from 'vitest';
import {
  assertValidEvmAddress,
  assertValidChainSlug,
  assertValidTimeframe,
  assertValidLimit,
} from '../../src/discovery/cliExec';

describe('assertValidEvmAddress', () => {
  it('accepts a well-formed address', () => {
    expect(assertValidEvmAddress('0x' + '11'.repeat(20))).toBe('0x' + '11'.repeat(20));
  });

  it('rejects a value crafted to look like a CLI flag', () => {
    expect(() => assertValidEvmAddress('--config=/etc/passwd')).toThrow();
  });

  it('rejects a too-short or malformed address', () => {
    expect(() => assertValidEvmAddress('0x1234')).toThrow();
    expect(() => assertValidEvmAddress('not-an-address')).toThrow();
  });
});

describe('assertValidChainSlug', () => {
  it('accepts a simple lowercase slug', () => {
    expect(assertValidChainSlug('robinhood')).toBe('robinhood');
  });

  it('rejects anything with spaces, flags, or shell-special characters', () => {
    expect(() => assertValidChainSlug('robinhood; rm -rf /')).toThrow();
    expect(() => assertValidChainSlug('--flag')).toThrow();
    expect(() => assertValidChainSlug('Robinhood')).toThrow(); // must be lowercase per the allowlist
  });
});

describe('assertValidTimeframe', () => {
  it('accepts "6h"', () => {
    expect(assertValidTimeframe('6h')).toBe('6h');
  });

  it('rejects anything outside the NdH/NdD shape', () => {
    expect(() => assertValidTimeframe('--min-gas-fee')).toThrow();
    expect(() => assertValidTimeframe('6 hours')).toThrow();
  });
});

describe('assertValidLimit', () => {
  it('accepts an integer within range', () => {
    expect(assertValidLimit(10)).toBe(10);
  });

  it('rejects non-integers and out-of-range values', () => {
    expect(() => assertValidLimit(0)).toThrow();
    expect(() => assertValidLimit(1000)).toThrow();
    expect(() => assertValidLimit(1.5)).toThrow();
  });
});

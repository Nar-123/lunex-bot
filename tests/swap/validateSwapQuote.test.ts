import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { validateSwapQuote, SwapQuoteValidationError } from '../../src/swap/validateSwapQuote';
import type { RawSwapTxCandidate } from '../../src/swap/validateSwapQuote';
import { urExecuteCalldata } from './urCalldataFixture';

const ALLOWED_ROUTER = '0x1111111111111111111111111111111111111111';
const TOKEN_IN = '0x7777777777777777777777777777777777777777';
const RECIPIENT = '0x9999999999999999999999999999999999999999' as Address;
const NOW = Math.floor(Date.now() / 1000);

/**
 * EXIT-ROUTER RESOLUTION: a direct Universal Router target now carries a real
 * command batch that is decoded and checked, so the fixture is real calldata
 * rather than a placeholder -- the test exercises the production decoder.
 */
const VALID: RawSwapTxCandidate = {
  to: ALLOWED_ROUTER,
  data: urExecuteCalldata({ recipient: RECIPIENT, tokenIn: TOKEN_IN as Address, amountIn: 500n }),
  value: '0',
  chainId: 4663,
  echoedAmountInRaw: 500n,
  minOutputAmountRaw: 0n,
};
const POLICY = { chainId: 4663, universalRouters: [ALLOWED_ROUTER], swapProxies: [] as string[] };
const EXPECTED = { amountInRaw: 500n, chainId: 4663, minReceivedRequired: false, targets: POLICY, tokenIn: TOKEN_IN, recipient: RECIPIENT, now: NOW };

describe('validateSwapQuote -- structural validation before trusting external swap calldata', () => {
  it('accepts a well-formed candidate targeting the configured allowed router, and returns a clean TxRequest', () => {
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
    expect(() => validateSwapQuote({ ...VALID, data: '0xzz' }, EXPECTED)).toThrow(SwapQuoteValidationError);
  });

  it('rejects "data" shorter than a 4-byte function selector', () => {
    expect(() => validateSwapQuote({ ...VALID, data: '0xab' }, EXPECTED)).toThrow(SwapQuoteValidationError);
  });

  it('EXIT-ROUTER RESOLUTION: a bare 4-byte selector at a Universal Router is now REJECTED -- a direct router call must be a real, decodable command batch', () => {
    expect(() => validateSwapQuote({ ...VALID, data: '0xabcdef12' }, EXPECTED)).toThrow(/universal router calldata selector/);
  });

  it('the minimum-length rule still guards a SwapProxy target, where calldata is not a router command batch', () => {
    const proxyPolicy = { chainId: 4663, universalRouters: [ALLOWED_ROUTER], swapProxies: ['0x2222222222222222222222222222222222222222'] };
    expect(() =>
      validateSwapQuote(
        { ...VALID, to: '0x2222222222222222222222222222222222222222', data: '0x1234' },
        { ...EXPECTED, targets: proxyPolicy },
      ),
    ).toThrow(SwapQuoteValidationError);
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

  describe('H9 regression: swap target identity, not just address shape', () => {
    const RANDOM_CONTRACT = '0x4444444444444444444444444444444444444444';
    const EOA = '0x5555555555555555555555555555555555555555';

    it('valid router: exact match against the configured allowed router is accepted', () => {
      expect(() => validateSwapQuote({ ...VALID, to: ALLOWED_ROUTER }, EXPECTED)).not.toThrow();
    });

    it('valid router: matches case-insensitively (checksummed vs lowercase)', () => {
      expect(() => validateSwapQuote({ ...VALID, to: ALLOWED_ROUTER.toUpperCase().replace('0X', '0x') }, EXPECTED)).not.toThrow();
    });

    it('invalid router: a DIFFERENT, well-formed router address is rejected, not silently accepted', () => {
      const differentRouter = '0x2222222222222222222222222222222222222222';
      expect(() => validateSwapQuote({ ...VALID, to: differentRouter }, EXPECTED)).toThrow(/is not an approved execution target/);
    });

    it('random contract: an arbitrary, unrelated contract address is rejected', () => {
      expect(() => validateSwapQuote({ ...VALID, to: RANDOM_CONTRACT }, EXPECTED)).toThrow(SwapQuoteValidationError);
    });

    it('EOA: a plain externally-owned-account-shaped address is rejected exactly like any other non-matching address', () => {
      expect(() => validateSwapQuote({ ...VALID, to: EOA }, EXPECTED)).toThrow(SwapQuoteValidationError);
    });

    it('FAIL CLOSED: an empty/unconfigured allowedRouterAddress rejects EVERY swap, never falls back to shape-only validation', () => {
      expect(() => validateSwapQuote(VALID, { ...EXPECTED, targets: { ...POLICY, universalRouters: [] } })).toThrow(/no approved Universal Router is configured/);
    });

    it('wrong chain router: a real router address that only happens to be valid on a DIFFERENT chain is still just "not the configured router" here -- this project has exactly one configured address per deployment, never a multi-chain allowlist', () => {
      const otherChainRouterAddress = '0x3333333333333333333333333333333333333333';
      expect(() => validateSwapQuote({ ...VALID, to: otherChainRouterAddress }, EXPECTED)).toThrow(
        SwapQuoteValidationError,
      );
    });

    it('non-zero value: rejected outright -- every swap here is ERC20 TOKEN -> ERC20 USDG, native ETH is never involved', () => {
      expect(() => validateSwapQuote({ ...VALID, value: '1000000000000000000' }, EXPECTED)).toThrow(/"value" must be 0/);
    });

    it('zero value is accepted (the only valid value for an ERC20->ERC20 swap)', () => {
      expect(() => validateSwapQuote({ ...VALID, value: '0' }, EXPECTED)).not.toThrow();
    });
  });
});

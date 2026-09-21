import { describe, expect, it } from 'vitest';
import { SwapQuoteValidationError, validateSwapQuote, type RawSwapTxCandidate, type SwapQuoteExpectation } from '../../src/swap/validateSwapQuote';
import { SWAP_PROXY_EXECUTE_SELECTOR } from '../../src/swap/executionTargets';
import { APPROVED_PROXY, APPROVED_ROUTER, LEGACY_PROXY, POLICY, proxyCalldata, TOKEN, UNVERIFIED_ROUTER } from './executionTargetFixtures';
import { urExecuteCalldata } from './urCalldataFixture';
import type { Address } from 'viem';

const AMOUNT = 500n;
const RECIPIENT = '0x9999999999999999999999999999999999999999' as Address;
const NOW = Math.floor(Date.now() / 1000);
/** EXIT-ROUTER RESOLUTION: CASE A now carries a real, decodable command batch. */
const UR_DATA = urExecuteCalldata({ recipient: RECIPIENT, tokenIn: TOKEN as Address, amountIn: AMOUNT, amountOutMin: 1n });
const base = (over: Partial<RawSwapTxCandidate> = {}): RawSwapTxCandidate => ({
  to: APPROVED_ROUTER,
  data: UR_DATA,
  value: '0',
  chainId: 4663,
  echoedAmountInRaw: AMOUNT,
  minOutputAmountRaw: 1n,
  ...over,
});
const expected = (over: Partial<SwapQuoteExpectation> = {}): SwapQuoteExpectation => ({
  amountInRaw: AMOUNT,
  chainId: 4663,
  minReceivedRequired: true,
  targets: POLICY,
  tokenIn: TOKEN,
  recipient: RECIPIENT,
  now: NOW,
  ...over,
});
const viaProxy = (over: Parameters<typeof proxyCalldata>[0] = {}): RawSwapTxCandidate => base({ to: APPROVED_PROXY, data: proxyCalldata(over) });

describe('two-layer execution-target validation', () => {
  it('1. CASE A: a direct approved Universal Router is accepted and returns clean calldata', () => {
    expect(validateSwapQuote(base(), expected())).toEqual({ to: APPROVED_ROUTER, data: UR_DATA, value: 0n });
  });

  it('2. CASE B: an approved SwapProxy is accepted when the EMBEDDED router is approved', () => {
    const candidate = viaProxy();
    expect(validateSwapQuote(candidate, expected())).toEqual({ to: APPROVED_PROXY, data: candidate.data, value: 0n });
  });

  it('3. an approved SwapProxy carrying an UNAUTHORISED embedded router is rejected', () => {
    expect(() => validateSwapQuote(viaProxy({ router: UNVERIFIED_ROUTER }), expected())).toThrow(/names router .* NOT an approved Universal Router/i);
  });

  it('3b. a proxy payload naming the proxy itself, or an EOA, is still rejected', () => {
    for (const router of [APPROVED_PROXY, '0x1234567890123456789012345678901234567890']) {
      expect(() => validateSwapQuote(viaProxy({ router }), expected())).toThrow(SwapQuoteValidationError);
    }
  });

  it('4. CASE D: the deprecated legacy proxy is rejected even with a perfectly valid embedded router', () => {
    const candidate = base({ to: LEGACY_PROXY, data: proxyCalldata() });
    expect(() => validateSwapQuote(candidate, expected())).toThrow(/is not an approved execution target/);
  });

  it('5. CASE C: an unknown target is rejected', () => {
    expect(() => validateSwapQuote(base({ to: '0x9999999999999999999999999999999999999999' }), expected())).toThrow(/is not an approved execution target/);
  });

  it('6. malformed proxy calldata is rejected (fail closed, never "probably fine")', () => {
    expect(() => validateSwapQuote(base({ to: APPROVED_PROXY, data: `${SWAP_PROXY_EXECUTE_SELECTOR}${'ff'.repeat(192)}` }), expected())).toThrow(/could not be safely decoded/);
  });

  it('7. truncated proxy calldata is rejected', () => {
    expect(() => validateSwapQuote(base({ to: APPROVED_PROXY, data: proxyCalldata().slice(0, 74) }), expected())).toThrow(/truncated|could not be safely decoded/);
  });

  it('8. a wrong selector on an approved proxy is rejected', () => {
    expect(() => validateSwapQuote(base({ to: APPROVED_PROXY, data: `0x3593564c${proxyCalldata().slice(10)}` }), expected())).toThrow(/selector .* is not 0x2894adf9/);
  });

  it('9. chainId mismatch is still rejected first', () => {
    expect(() => validateSwapQuote(base({ chainId: 1 }), expected())).toThrow(/chainId mismatch/);
  });

  it('10. amount mismatch is rejected -- both the API echo and the amount inside proxy calldata', () => {
    expect(() => validateSwapQuote(base({ echoedAmountInRaw: 499n }), expected())).toThrow(/amount-in mismatch/);
    expect(() => validateSwapQuote(viaProxy({ amount: 499n }), expected())).toThrow(/pulls 499 of the token/);
  });

  it('10b. a proxy payload selling a DIFFERENT token than quoted is rejected', () => {
    expect(() => validateSwapQuote(viaProxy({ token: '0x1111111111111111111111111111111111111111' }), expected())).toThrow(/sells token .* but this swap was quoted for/);
  });

  it('11. non-zero value is rejected for both target kinds', () => {
    expect(() => validateSwapQuote(base({ value: '1' }), expected())).toThrow(/"value" must be 0/);
    expect(() => validateSwapQuote({ ...viaProxy(), value: '1' }, expected())).toThrow(/"value" must be 0/);
  });

  it('12. minimum-received protection still applies on the proxy path', () => {
    expect(() => validateSwapQuote({ ...viaProxy(), minOutputAmountRaw: 0n }, expected())).toThrow(/minimum-received protection/);
    expect(() => validateSwapQuote({ ...viaProxy(), minOutputAmountRaw: 0n }, expected({ minReceivedRequired: false }))).not.toThrow();
  });

  it('13. FAIL CLOSED: an empty router allowlist rejects everything, including a proxy target', () => {
    const noRouters = expected({ targets: { ...POLICY, universalRouters: [] } });
    expect(() => validateSwapQuote(base(), noRouters)).toThrow(/no approved Universal Router is configured/);
    expect(() => validateSwapQuote(viaProxy(), noRouters)).toThrow(/no approved Universal Router is configured/);
  });

  it('14. an empty proxy allowlist rejects proxy targets while direct routers still work', () => {
    const noProxies = expected({ targets: { ...POLICY, swapProxies: [] } });
    expect(() => validateSwapQuote(viaProxy(), noProxies)).toThrow(/is not an approved execution target/);
    expect(() => validateSwapQuote(base(), noProxies)).not.toThrow();
  });

  it('address normalization: checksummed vs lowercase target AND embedded router are both accepted', () => {
    expect(() => validateSwapQuote(base({ to: APPROVED_ROUTER.toLowerCase() }), expected())).not.toThrow();
    expect(() => validateSwapQuote(base({ to: APPROVED_PROXY.toUpperCase().replace('0X', '0x'), data: proxyCalldata({ router: APPROVED_ROUTER.toLowerCase() }) }), expected())).not.toThrow();
    expect(() => validateSwapQuote(viaProxy({ token: TOKEN.toLowerCase() }), expected({ tokenIn: TOKEN.toUpperCase().replace('0X', '0x') }))).not.toThrow();
  });

  it('startup identity gate: FAILED blocks every swap; NOT_CHECKED/VERIFIED do not', () => {
    expect(() => validateSwapQuote(base(), expected({ identityGate: 'FAILED' }))).toThrow(/identity verification FAILED/);
    expect(() => validateSwapQuote(base(), expected({ identityGate: 'VERIFIED' }))).not.toThrow();
    expect(() => validateSwapQuote(base(), expected({ identityGate: 'NOT_CHECKED' }))).not.toThrow();
  });

  it('regression: proxy validation is never treated as router validation (the proxy is not accepted as an embedded router, and a router is not accepted as a proxy target)', () => {
    expect(() => validateSwapQuote(viaProxy({ router: APPROVED_PROXY }), expected())).toThrow(SwapQuoteValidationError);
    // a direct router target carries a Universal Router command batch, never proxy calldata...
    expect(() => validateSwapQuote(base(), expected())).not.toThrow();
    // ...and a bare selector with no decodable batch is now refused rather than waved through
    expect(() => validateSwapQuote(base({ data: '0x3593564c' }), expected())).toThrow(SwapQuoteValidationError);
  });
});

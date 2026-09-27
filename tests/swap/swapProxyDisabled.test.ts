import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import {
  SwapQuoteValidationError,
  validateSwapQuote,
  type RawSwapTxCandidate,
  type SwapQuoteExpectation,
} from '../../src/swap/validateSwapQuote';
import { SWAP_PROXY_EXECUTE_SELECTOR } from '../../src/swap/executionTargets';
import { APPROVED_PROXY, APPROVED_ROUTER, POLICY, proxyCalldata, TOKEN, UNVERIFIED_ROUTER } from './executionTargetFixtures';
import { FIXTURE_USDG, urExecuteCalldata } from './urCalldataFixture';
import { executeCriticalTransaction } from '../../src/execution/executeCriticalTransaction';
import type { TxSafetyDeps } from '../../src/execution/types';
import { InMemoryTransactionAttemptRepository } from '../execution/inMemoryTransactionAttemptRepository';

/**
 * The SwapProxy execution path is disabled: no proxy-targeted quote may be
 * signed, whatever its calldata and whatever the allowlist says.
 *
 * Why a dedicated file: `twoLayerValidation.test.ts` covers the two-layer
 * classification contract. This one pins the narrower, safety-critical claim --
 * a proxy quote is refused, and the refusal happens at the BUILD step, strictly
 * before a nonce is allocated, anything is signed, or anything is broadcast.
 */

const AMOUNT = 500n;
const RECIPIENT = '0x9999999999999999999999999999999999999999' as Address;
const NOW = Math.floor(Date.now() / 1000);
const UR_DATA = urExecuteCalldata({ recipient: RECIPIENT, tokenIn: TOKEN as Address, amountIn: AMOUNT, amountOutMin: 1n });

const candidate = (over: Partial<RawSwapTxCandidate> = {}): RawSwapTxCandidate => ({
  to: APPROVED_ROUTER,
  data: UR_DATA,
  value: '0',
  chainId: 4663,
  echoedAmountInRaw: AMOUNT,
  minOutputAmountRaw: 1n,
  ...over,
});
const expectation = (over: Partial<SwapQuoteExpectation> = {}): SwapQuoteExpectation => ({
  amountInRaw: AMOUNT,
  chainId: 4663,
  minReceivedRequired: true,
  targets: POLICY,
  tokenIn: TOKEN,
  tokenOut: FIXTURE_USDG,
  recipient: RECIPIENT,
  now: NOW,
  ...over,
});
/** A proxy-targeted candidate. `over` shapes the proxy calldata. */
const proxy = (over: Parameters<typeof proxyCalldata>[0] = {}): RawSwapTxCandidate =>
  candidate({ to: APPROVED_PROXY, data: proxyCalldata(over) });

const DISABLED = /SwapProxy execution path is disabled/;

describe('SwapProxy execution path is disabled -- no proxy quote can be signed', () => {
  it('refuses a perfectly well-formed proxy payload naming an APPROVED router', () => {
    // The case that used to be accepted, and the one that matters most: nothing
    // about the payload is wrong except that it goes through the proxy.
    expect(() => validateSwapQuote(proxy(), expectation())).toThrow(SwapQuoteValidationError);
    expect(() => validateSwapQuote(proxy(), expectation())).toThrow(DISABLED);
  });

  it('names the proxy address in the refusal, so the operator can see what was refused', () => {
    expect(() => validateSwapQuote(proxy(), expectation())).toThrow(new RegExp(APPROVED_PROXY, 'i'));
  });

  it.each([
    ['unapproved embedded router', () => proxy({ router: UNVERIFIED_ROUTER })],
    ['the proxy naming itself as router', () => proxy({ router: APPROVED_PROXY })],
    ['an EOA as router', () => proxy({ router: '0x1234567890123456789012345678901234567890' })],
    ['a different token than quoted', () => proxy({ token: '0x1111111111111111111111111111111111111111' })],
    ['a different amount than quoted', () => proxy({ amount: 499n })],
    ['malformed calldata (head words point nowhere)', () => candidate({ to: APPROVED_PROXY, data: `${SWAP_PROXY_EXECUTE_SELECTOR}${'ff'.repeat(192)}` })],
    ['truncated calldata', () => candidate({ to: APPROVED_PROXY, data: proxyCalldata().slice(0, 74) })],
    ['a bare selector', () => candidate({ to: APPROVED_PROXY, data: SWAP_PROXY_EXECUTE_SELECTOR })],
    ['a foreign selector', () => candidate({ to: APPROVED_PROXY, data: `0x3593564c${proxyCalldata().slice(10)}` })],
    ['empty calldata', () => candidate({ to: APPROVED_PROXY, data: '0x' })],
    ['a Universal Router command batch sent to the proxy', () => candidate({ to: APPROVED_PROXY, data: UR_DATA })],
  ])('refuses every proxy calldata shape: %s', (_label, build) => {
    expect(() => validateSwapQuote(build(), expectation())).toThrow(DISABLED);
  });

  it('refuses regardless of the startup identity gate -- even VERIFIED does not re-open the path', () => {
    for (const identityGate of ['VERIFIED', 'NOT_CHECKED'] as const) {
      expect(() => validateSwapQuote(proxy(), expectation({ identityGate }))).toThrow(DISABLED);
    }
  });

  it('refuses whether or not minimum-received protection is on', () => {
    for (const minReceivedRequired of [true, false]) {
      expect(() => validateSwapQuote(proxy(), expectation({ minReceivedRequired }))).toThrow(DISABLED);
    }
  });

  it('refuses before the amount/value/min-out checks -- the target kind decides first', () => {
    // A proxy candidate that is ALSO wrong in another way still reports the
    // disabled path, proving the check is ordered ahead of the rest.
    const alsoWrong = { ...proxy(), value: '1', echoedAmountInRaw: 1n, minOutputAmountRaw: 0n };
    expect(() => validateSwapQuote(alsoWrong, expectation())).toThrow(DISABLED);
  });

  it('is config-independent: the refusal does not depend on the proxy being allowlisted', () => {
    // Allowlisted -> refused by the disabled-path rule.
    expect(() => validateSwapQuote(proxy(), expectation())).toThrow(DISABLED);
    // Not allowlisted -> refused earlier still, as an unapproved target. Either
    // way it never reaches signing, so removing the allowlist entry is not
    // required for the fail-closed behaviour (and the allowlist is unchanged).
    const noProxies = expectation({ targets: { ...POLICY, swapProxies: [] } });
    expect(() => validateSwapQuote(proxy(), noProxies)).toThrow(/is not an approved execution target/);
  });

  it('the direct Universal Router path is untouched and still accepted', () => {
    expect(validateSwapQuote(candidate(), expectation())).toEqual({ to: APPROVED_ROUTER, data: UR_DATA, value: 0n });
  });
});

/**
 * End-to-end: the refusal lands at the BUILD checkpoint of the mandatory
 * transaction-safety pipeline, so no nonce is allocated, nothing is signed and
 * nothing is broadcast. `buildTransaction` is where production calls
 * `validateSwapQuote` (see `exits/swapTx.ts`), so this wires the real validator
 * into the real state machine.
 */
describe('a proxy quote cannot reach signing or broadcast', () => {
  const depsWithRealValidation = (): TxSafetyDeps<{ ok: true }> => ({
    buildTransaction: vi.fn(async () => validateSwapQuote(proxy(), expectation())),
    simulate: vi.fn(async () => ({ ok: true }) as const),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    checkGasAffordable: vi.fn(async () => ({ ok: true }) as const),
    getNonce: vi.fn(async () => 7),
    signTransaction: vi.fn(async () => ({ raw: '0xdead' as `0x${string}`, hash: `0x${'ab'.repeat(32)}` as `0x${string}` })),
    broadcastRaw: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 1n })),
    getReceiptIfAvailable: vi.fn(async () => null),
    verifyOnChain: vi.fn(async () => ({ ok: true as const, data: { ok: true as const } })),
  });

  it('fails at BUILD: no nonce allocated, nothing signed, nothing broadcast', async () => {
    const repo = new InMemoryTransactionAttemptRepository();
    const deps = depsWithRealValidation();

    const result = await executeCriticalTransaction('proxy-swap', 'exit:swap', deps, repo, { log: vi.fn() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(DISABLED);
      // Never advanced past PENDING: no BUILT, no NONCE_ASSIGNED, no SIGNED.
      expect(result.attempt.status).toBe('PENDING');
      expect(result.attempt.nonce).toBeNull();
      expect(result.attempt.rawTx).toBeNull();
      expect(result.attempt.txHash).toBeNull();
    }
    expect(deps.getNonce).not.toHaveBeenCalled();
    expect(deps.signTransaction).not.toHaveBeenCalled();
    expect(deps.broadcastRaw).not.toHaveBeenCalled();
    expect(deps.waitForReceipt).not.toHaveBeenCalled();
    // Nothing reached the chain, so nothing is left holding a nonce either.
    expect(await repo.findSignedNoncesAtOrAbove(0)).toEqual([]);
  });

  it('stays refused across repeated ticks -- it never becomes signable by retrying', async () => {
    const repo = new InMemoryTransactionAttemptRepository();

    for (let i = 0; i < 5; i++) {
      const deps = depsWithRealValidation();
      const result = await executeCriticalTransaction('proxy-swap-retry', 'exit:swap', deps, repo, { log: vi.fn() });
      expect(result.ok).toBe(false);
      expect(deps.signTransaction).not.toHaveBeenCalled();
      expect(deps.broadcastRaw).not.toHaveBeenCalled();
    }
    expect(await repo.findSignedNoncesAtOrAbove(0)).toEqual([]);
  });
});

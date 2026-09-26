import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, parseAbi, type Address } from 'viem';
import { validateSwapQuote } from '../../src/swap/validateSwapQuote';
import { assertUniversalRouterCallSafe, decodeSwapCommand, COMMAND } from '../../src/swap/universalRouterCalldata';
import { EXECUTION_TARGETS } from '../../src/config/constants';
import { config } from '../../src/config';
import { FIXTURE_USDG, v3Path } from './urCalldataFixture';

/**
 * D8 regression suite for the two calldata blockers:
 *
 *   FIX 3 -- a leg's OUTPUT token was never checked, so a leg selling the right
 *            TOKEN into the wrong asset passed validation.
 *   FIX 4 -- `amountOutMin > 0` was the only minimum-received check, so a leg
 *            guaranteeing 1 wei satisfied a policy minimum of any size.
 *
 * Every payload is real, encoded Universal Router `execute(...)` calldata.
 */
const UR = EXECUTION_TARGETS[4663]!.universalRouters[0]! as Address;
const TARGETS = { chainId: 4663, universalRouters: [UR], swapProxies: [] as string[] };
const TOKEN = '0x39dBED3a2bd333467115dE45665cC57F813C4571' as Address;
/** A plausible-looking but NOT configured stablecoin -- the asset an attacker would route to. */
const OTHER = '0xdeadbeef00000000000000000000000000000001' as Address;
const WETH = '0x4200000000000000000000000000000000000006' as Address;
const WALLET = '0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea' as Address;
const AMT = 1_000_000n;
/** The minimum THIS project computes from the quote and its slippage tier. */
const POLICY_MIN = 9_000n;
const NOW = Math.floor(Date.now() / 1000);
const ABI = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline)']);

interface Leg {
  amountIn: bigint;
  amountOutMin?: bigint;
  tokenIn?: Address;
  tokenOut?: Address;
  /** V3 only: an intermediate hop, to prove a multi-hop path is judged by where it ENDS. */
  via?: Address;
}
const v3 = (l: Leg): `0x${string}` => {
  const path = l.via
    ? (`${v3Path(l.tokenIn ?? TOKEN, l.via)}000bb8${(l.tokenOut ?? FIXTURE_USDG).slice(2)}` as `0x${string}`)
    : v3Path(l.tokenIn ?? TOKEN, l.tokenOut ?? FIXTURE_USDG);
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    [WALLET, l.amountIn, l.amountOutMin ?? POLICY_MIN, path, true],
  );
};
const v2 = (l: Leg & { path?: Address[] }): `0x${string}` =>
  encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'bool' }],
    [WALLET, l.amountIn, l.amountOutMin ?? POLICY_MIN, l.path ?? [l.tokenIn ?? TOKEN, l.tokenOut ?? FIXTURE_USDG], true],
  );
const batch = (commands: `0x${string}`, inputs: `0x${string}`[]): `0x${string}` =>
  encodeFunctionData({ abi: ABI, functionName: 'execute', args: [commands, inputs, BigInt(NOW + 600)] });

const EXPECT = {
  amountInRaw: AMT,
  chainId: 4663,
  minReceivedRequired: true,
  targets: TARGETS,
  tokenIn: TOKEN,
  tokenOut: FIXTURE_USDG,
  recipient: WALLET,
  now: NOW,
};
const run = (data: `0x${string}`, minOut = POLICY_MIN, expected: Partial<typeof EXPECT> = {}) =>
  validateSwapQuote({ to: UR, data, value: '0', chainId: 4663, echoedAmountInRaw: AMT, minOutputAmountRaw: minOut }, { ...EXPECT, ...expected });
const accepted = (data: `0x${string}`, minOut = POLICY_MIN) => expect(() => run(data, minOut)).not.toThrow();
const rejected = (data: `0x${string}`, re: RegExp, minOut = POLICY_MIN) => expect(() => run(data, minOut)).toThrow(re);

describe('FIX 3 -- every leg must end at the OFFICIAL configured USDG', () => {
  it('the fixture USDG really is the configured quote asset (otherwise these tests prove nothing)', () => {
    expect(FIXTURE_USDG.toLowerCase()).toBe(config.quoteAsset.ADDRESS.toLowerCase());
  });

  it('V2 TOKEN -> OTHER -> REJECTED', () => {
    rejected(batch('0x08', [v2({ amountIn: AMT, tokenOut: OTHER })]), /leg 0 pays out .*must end at the configured quote asset/i);
  });

  it('V3 TOKEN -> OTHER -> REJECTED', () => {
    rejected(batch('0x00', [v3({ amountIn: AMT, tokenOut: OTHER })]), /leg 0 pays out .*must end at the configured quote asset/i);
  });

  it('two legs, one to USDG and one to OTHER -> REJECTED (the mixed case the old code would have passed)', () => {
    rejected(batch('0x0000', [v3({ amountIn: AMT / 2n }), v3({ amountIn: AMT / 2n, tokenOut: OTHER })]), /leg 1 pays out/);
    // and in the other order, so it cannot be a "first leg only" check again
    rejected(batch('0x0008', [v3({ amountIn: AMT / 2n, tokenOut: OTHER }), v2({ amountIn: AMT / 2n })]), /leg 0 pays out/);
  });

  it('two valid TOKEN -> USDG legs -> ACCEPTED', () => {
    accepted(batch('0x0008', [v3({ amountIn: AMT / 2n }), v2({ amountIn: AMT / 2n })]));
  });

  it('a V2 path naming no destination at all (single element) -> REJECTED, never skipped', () => {
    rejected(batch('0x08', [v2({ amountIn: AMT, path: [TOKEN] })]), /malformed path|names no output token/);
  });

  it('a MULTI-HOP V3 path is judged by where it ends: TOKEN -> WETH -> USDG accepted, TOKEN -> WETH -> OTHER refused', () => {
    accepted(batch('0x00', [v3({ amountIn: AMT, via: WETH })]));
    rejected(batch('0x00', [v3({ amountIn: AMT, via: WETH, tokenOut: OTHER })]), /leg 0 pays out/);
  });

  it('the decoder itself now reports both endpoints of a path', () => {
    const decodedV3 = decodeSwapCommand(COMMAND.V3_SWAP_EXACT_IN, v3({ amountIn: AMT }));
    expect(decodedV3?.tokenIn?.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(decodedV3?.tokenOut?.toLowerCase()).toBe(FIXTURE_USDG.toLowerCase());
    const decodedV2 = decodeSwapCommand(COMMAND.V2_SWAP_EXACT_IN, v2({ amountIn: AMT }));
    expect(decodedV2?.tokenOut?.toLowerCase()).toBe(FIXTURE_USDG.toLowerCase());
    // a 1-element V2 path names neither a usable input nor an output
    expect(decodeSwapCommand(COMMAND.V2_SWAP_EXACT_IN, v2({ amountIn: AMT, path: [TOKEN] }))?.tokenOut).toBeNull();
  });
});

describe('FIX 4 -- the calldata minimums are bound to the policy minimum, not merely positive', () => {
  it('a single leg guaranteeing EXACTLY the policy minimum -> ACCEPTED', () => {
    accepted(batch('0x00', [v3({ amountIn: AMT, amountOutMin: POLICY_MIN })]));
  });

  it('a single leg guaranteeing one wei BELOW the policy minimum -> REJECTED', () => {
    rejected(batch('0x00', [v3({ amountIn: AMT, amountOutMin: POLICY_MIN - 1n })]), /guarantee only 8999 .*below the 9000 .*short by 1/);
  });

  it('a positive but token-sized minimum (1 wei) no longer satisfies a real policy minimum -- the pre-D8 hole', () => {
    rejected(batch('0x00', [v3({ amountIn: AMT, amountOutMin: 1n })]), /guarantee only 1 .*below the 9000/);
  });

  it('two legs whose minimums SUM to the policy minimum -> ACCEPTED (a split route is judged in aggregate)', () => {
    accepted(batch('0x0008', [v3({ amountIn: AMT / 2n, amountOutMin: 4_000n }), v2({ amountIn: AMT / 2n, amountOutMin: 5_000n })]));
  });

  it('a WEAKENED SECOND leg that drags the aggregate below the policy minimum -> REJECTED', () => {
    rejected(
      batch('0x0008', [v3({ amountIn: AMT / 2n, amountOutMin: 4_000n }), v2({ amountIn: AMT / 2n, amountOutMin: 1n })]),
      /guarantee only 4001 .*below the 9000/,
    );
  });

  it('a zero minimum on any leg is still refused outright, before the aggregate is even considered', () => {
    rejected(batch('0x0008', [v3({ amountIn: AMT / 2n, amountOutMin: 20_000n }), v2({ amountIn: AMT / 2n, amountOutMin: 0n })]), /leg 1 carries a zero amountOutMin/);
  });

  it('protection enabled but NO policy minimum computed -> fail closed, never validated against nothing', () => {
    rejected(batch('0x00', [v3({ amountIn: AMT })]), /minimum-received protection is enabled/, 0n);
  });

  it('with protection OFF the aggregate bound does not apply (the documented OFF state), but the per-leg zero check still does', () => {
    expect(() => run(batch('0x00', [v3({ amountIn: AMT, amountOutMin: 1n })]), 0n, { minReceivedRequired: false })).not.toThrow();
    expect(() => run(batch('0x00', [v3({ amountIn: AMT, amountOutMin: 0n })]), 0n, { minReceivedRequired: false })).toThrow(/zero amountOutMin/);
  });

  it('the calldata validator fails closed on its OWN contract too, not only via validateSwapQuote', () => {
    // `validateSwapQuote` rejects a zero policy minimum separately; this pins the
    // router-level guard directly, so the module cannot be weakened by a future
    // caller that skips the outer check.
    const data = batch('0x00', [v3({ amountIn: AMT })]);
    const expectation = { tokenIn: TOKEN, tokenOut: FIXTURE_USDG, amountInRaw: AMT, minReceivedRequired: true, recipient: WALLET, now: NOW };
    expect(() => assertUniversalRouterCallSafe(data, { ...expectation, minOutputAmountRaw: 0n })).toThrow(/minimum-received protection is enabled/);
    expect(() => assertUniversalRouterCallSafe(data, { ...expectation, minOutputAmountRaw: POLICY_MIN })).not.toThrow();
    expect(() => assertUniversalRouterCallSafe(data, { ...expectation, minOutputAmountRaw: POLICY_MIN + 1n })).toThrow(/below the 9001/);
  });

  it('the policy minimum is compared against the SUM, so a large first leg cannot cover a missing second one beyond it', () => {
    // 9000 total required; legs guarantee 8000 + 999 = 8999
    rejected(batch('0x0000', [v3({ amountIn: AMT / 2n, amountOutMin: 8_000n }), v3({ amountIn: AMT / 2n, amountOutMin: 999n })]), /short by 1/);
    accepted(batch('0x0000', [v3({ amountIn: AMT / 2n, amountOutMin: 8_000n }), v3({ amountIn: AMT / 2n, amountOutMin: 1_000n })]));
  });
});

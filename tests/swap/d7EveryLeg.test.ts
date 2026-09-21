import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, parseAbi, type Address } from 'viem';
import { validateSwapQuote, SwapQuoteValidationError } from '../../src/swap/validateSwapQuote';
import { ALLOWED_EXIT_COMMANDS, COMMAND } from '../../src/swap/universalRouterCalldata';
import { EXECUTION_TARGETS } from '../../src/config/constants';
import { v3Path } from './urCalldataFixture';

/**
 * D7 regression suite for the two blockers found in the pre-D6 audit of 7aa6f35:
 *
 *   1. V4_SWAP was accepted without decoding its nested payload.
 *   2. Only the FIRST swap command was validated (`findIndex`), so a legitimate
 *      first leg could carry an unchecked second leg.
 *
 * Every calldata here is real, encoded Universal Router `execute(...)`.
 */
const UR = EXECUTION_TARGETS[4663]!.universalRouters[0]! as Address;
const TARGETS = { chainId: 4663, universalRouters: [UR], swapProxies: [] as string[] };
const TOKEN = '0x39dBED3a2bd333467115dE45665cC57F813C4571' as Address;
const OTHER_TOKEN = '0x385f4f8ae47651ce5f58f5265395a669f8281e18' as Address;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;
const WALLET = '0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea' as Address;
const ATTACKER = '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0' as Address;
const AMT = 14467199568916222n;
const NOW = Math.floor(Date.now() / 1000);
const ABI = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline)']);

interface Leg { recipient?: Address; amountIn: bigint; amountOutMin?: bigint; payerIsUser?: boolean; tokenIn?: Address }
const v3 = (l: Leg): `0x${string}` => encodeAbiParameters(
  [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
  [l.recipient ?? WALLET, l.amountIn, l.amountOutMin ?? 1n, v3Path(l.tokenIn ?? TOKEN, USDG), l.payerIsUser ?? true],
);
const v2 = (l: Leg): `0x${string}` => encodeAbiParameters(
  [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'bool' }],
  [l.recipient ?? WALLET, l.amountIn, l.amountOutMin ?? 1n, [l.tokenIn ?? TOKEN, USDG], l.payerIsUser ?? true],
);
const batch = (commands: `0x${string}`, inputs: `0x${string}`[]): `0x${string}` =>
  encodeFunctionData({ abi: ABI, functionName: 'execute', args: [commands, inputs, BigInt(NOW + 600)] });

const EXPECT = { amountInRaw: AMT, chainId: 4663, minReceivedRequired: true, targets: TARGETS, tokenIn: TOKEN, recipient: WALLET, now: NOW };
const run = (data: `0x${string}`) => validateSwapQuote({ to: UR, data, value: '0', chainId: 4663, echoedAmountInRaw: AMT, minOutputAmountRaw: 1n }, EXPECT);
const accepted = (data: `0x${string}`) => expect(() => run(data)).not.toThrow();
const rejected = (data: `0x${string}`, re: RegExp) => expect(() => run(data)).toThrow(re);

describe('BLOCKER 1 -- V4_SWAP fails closed', () => {
  it('V4_SWAP with an arbitrary GARBAGE payload -> REJECTED', () => {
    rejected(batch('0x10', ['0xdeadbeefcafebabe']), /V4_SWAP .*refused/);
  });

  it('V4_SWAP with a VALID-LOOKING V4Router payload (swap/settle/take actions) -> REJECTED', () => {
    const actions = '0x060c0f'; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
    const params = [
      encodeAbiParameters([{ type: 'address' }, { type: 'uint128' }], [TOKEN, AMT]),
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [TOKEN, AMT]),
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [USDG, 1n]),
    ];
    const v4Input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params]);
    rejected(batch('0x10', [v4Input]), /V4_SWAP .*refused/);
  });

  it('V4_SWAP is refused even behind a perfectly valid V3 first leg', () => {
    rejected(batch('0x0010', [v3({ amountIn: AMT }), '0xdeadbeef']), /V4_SWAP .*position 1/);
  });

  it('V4_SWAP is refused with flag bits set in the command byte', () => {
    rejected(batch('0x90', ['0x00']), /V4_SWAP/);
  });

  it('V4_SWAP is no longer in the allowed command set', () => {
    expect(ALLOWED_EXIT_COMMANDS.has(COMMAND.V4_SWAP)).toBe(false);
    expect([...ALLOWED_EXIT_COMMANDS].sort()).toEqual([COMMAND.V3_SWAP_EXACT_IN, COMMAND.V2_SWAP_EXACT_IN].sort());
  });
});

describe('BLOCKER 2 -- every leg is validated', () => {
  it('valid V3 single-leg -> ACCEPTED', () => accepted(batch('0x00', [v3({ amountIn: AMT })])));

  it('valid V2 single-leg -> ACCEPTED', () => accepted(batch('0x08', [v2({ amountIn: AMT })])));

  it('valid two-leg split where BOTH legs pay the executor -> ACCEPTED', () => {
    accepted(batch('0x0008', [v3({ amountIn: AMT / 2n }), v2({ amountIn: AMT - AMT / 2n })]));
  });

  it('second leg ATTACKER recipient -> REJECTED', () => {
    rejected(batch('0x0000', [v3({ amountIn: AMT / 2n }), v3({ amountIn: AMT - AMT / 2n, recipient: ATTACKER })]), /leg 1 sends output to/);
  });

  it('second leg WRONG TOKEN -> REJECTED', () => {
    rejected(batch('0x0000', [v3({ amountIn: AMT / 2n }), v3({ amountIn: AMT - AMT / 2n, tokenIn: OTHER_TOKEN })]), /leg 1 sells token/);
  });

  it('second leg payerIsUser=false -> REJECTED', () => {
    rejected(batch('0x0000', [v3({ amountIn: AMT / 2n }), v3({ amountIn: AMT - AMT / 2n, payerIsUser: false })]), /leg 1 has payerIsUser=false/);
  });

  it('second leg amountOutMin=0 -> REJECTED', () => {
    rejected(batch('0x0000', [v3({ amountIn: AMT / 2n }), v3({ amountIn: AMT - AMT / 2n, amountOutMin: 0n })]), /leg 1 carries a zero amountOutMin/);
  });

  it('amount SUM < requested -> REJECTED', () => {
    rejected(batch('0x0000', [v3({ amountIn: AMT / 2n }), v3({ amountIn: AMT / 2n - 1n })]), /in total .*\(short by 1\)/);
  });

  it('amount SUM > requested -> REJECTED', () => {
    rejected(batch('0x0000', [v3({ amountIn: AMT / 2n }), v3({ amountIn: AMT })]), /in total .*\(over by \d+\)/);
  });

  it.each([
    ['first', '0x0500', ['0x00', v3({ amountIn: AMT })]],
    ['middle', '0x000500', [v3({ amountIn: AMT / 2n }), '0x00', v3({ amountIn: AMT - AMT / 2n })]],
    ['last', '0x0005', [v3({ amountIn: AMT }), '0x00']],
  ] as const)('an unknown command in the %s position -> REJECTED', (_where, commands, inputs) => {
    rejected(batch(commands, [...inputs] as `0x${string}`[]), /not an allowed exit-swap command/);
  });

  it('SWEEP and PAY_PORTION are refused -- no accepted command goes unchecked', () => {
    rejected(batch('0x0004', [v3({ amountIn: AMT }), '0x00']), /SWEEP/);
    rejected(batch('0x0006', [v3({ amountIn: AMT }), '0x00']), /PAY_PORTION/);
  });

  it('exact-OUTPUT swaps are refused', () => {
    rejected(batch('0x01', ['0x00']), /exact-OUTPUT/);
    rejected(batch('0x09', ['0x00']), /exact-OUTPUT/);
  });

  it('a malformed V3 path fails closed instead of skipping the token check', () => {
    const shortPath = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
      [WALLET, AMT, 1n, `0x${TOKEN.slice(2)}`, true], // 20 bytes: no fee, no output token
    );
    rejected(batch('0x00', [shortPath]), /malformed path/);
  });

  it('a non-positive leg amount is refused even when the total still adds up', () => {
    rejected(batch('0x0000', [v3({ amountIn: 0n }), v3({ amountIn: AMT })]), /non-positive input amount/);
  });

  it('PERMIT2_PERMIT and PERMIT2_PERMIT_BATCH are still refused, in any position', () => {
    rejected(batch('0x0a00', ['0x00', v3({ amountIn: AMT })]), /PERMIT2_PERMIT.*EIP-712/);
    rejected(batch('0x0003', [v3({ amountIn: AMT }), '0x00']), /PERMIT2_PERMIT_BATCH/);
  });

  it('strict command/input count is still enforced', () => {
    const data = encodeFunctionData({ abi: ABI, functionName: 'execute', args: ['0x0000', [v3({ amountIn: AMT })], BigInt(NOW + 600)] });
    rejected(data, /count mismatch/);
  });
});

describe('proof against the EXACT calldata shapes that reproduced the blockers in the pre-D6 audit', () => {
  // byte-for-byte the shapes from the audit of 7aa6f35, which were ACCEPTED then
  it('audit shape 1 -- V4_SWAP(0xdeadbeefcafebabe): was ACCEPTED, now REJECTED', () => {
    expect(() => run(batch('0x10', ['0xdeadbeefcafebabe']))).toThrow(SwapQuoteValidationError);
  });

  it('audit shape 2 -- legit leg + attacker leg with amountOutMin 0: was ACCEPTED, now REJECTED', () => {
    expect(() => run(batch('0x0000', [v3({ amountIn: AMT, amountOutMin: 1n }), v3({ amountIn: AMT, recipient: ATTACKER, amountOutMin: 0n })]))).toThrow(SwapQuoteValidationError);
  });

  it('audit shape 3 -- legitimate two-leg split: was wrongly REJECTED, now ACCEPTED', () => {
    expect(() => run(batch('0x0000', [v3({ amountIn: AMT / 2n }), v3({ amountIn: AMT - AMT / 2n })]))).not.toThrow();
  });
});

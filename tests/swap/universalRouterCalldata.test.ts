import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, parseAbi, type Address } from 'viem';
import { validateSwapQuote, SwapQuoteValidationError, type RawSwapTxCandidate, type SwapQuoteExpectation } from '../../src/swap/validateSwapQuote';
import { assertUniversalRouterCallSafe, decodeUniversalRouterExecute, UniversalRouterCalldataError } from '../../src/swap/universalRouterCalldata';
import { config } from '../../src/config';
import { EXECUTION_TARGETS } from '../../src/config/constants';
import { urExecuteCalldata, urWithPermitCommand } from './urCalldataFixture';

/**
 * Exit-router resolution: the Permit2-enabled Trading API flow targets the
 * APPROVED Universal Router directly. The calldata is then a command batch --
 * a program the router will run -- so it is decoded and checked before
 * anything signs it. Uses the REAL production allowlist.
 */
const TARGETS = config.uniswapTradingApi.executionTargets;
const UR = TARGETS.universalRouters[0] as Address;
const LEGACY_PROXY = '0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9';
const UNVERIFIED_ROUTER = '0x204FAca1764B154221e35c0d20aBb3c525710498';
const TOKEN = '0x39dBED3a2bd333467115dE45665cC57F813C4571' as Address;
const OTHER_TOKEN = '0x385f4f8ae47651ce5f58f5265395a669f8281e18' as Address;
const WALLET = '0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea' as Address;
const AMOUNT = 14467199568916222n;
const NOW = Math.floor(Date.now() / 1000);

const candidate = (o: Partial<RawSwapTxCandidate> = {}): RawSwapTxCandidate => ({
  to: UR,
  data: urExecuteCalldata({ recipient: WALLET, tokenIn: TOKEN, amountIn: AMOUNT, amountOutMin: 8156n }),
  value: '0',
  chainId: 4663,
  echoedAmountInRaw: AMOUNT,
  minOutputAmountRaw: 8156n,
  ...o,
});
const expectation = (o: Partial<SwapQuoteExpectation> = {}): SwapQuoteExpectation => ({
  amountInRaw: AMOUNT,
  chainId: 4663,
  minReceivedRequired: true,
  targets: TARGETS,
  tokenIn: TOKEN,
  recipient: WALLET,
  now: NOW,
  ...o,
});

describe('2-3, 25. target validation against the real allowlist', () => {
  it('2. a direct call to the approved Universal Router 0x8876... is accepted', () => {
    expect(UR.toLowerCase()).toBe('0x8876789976dEcBfCbBbe364623C63652db8C0904'.toLowerCase());
    const c = candidate();
    expect(validateSwapQuote(c, expectation())).toEqual({ to: UR, data: c.data, value: 0n });
  });

  it('3. the legacy proxy 0x02E5... is rejected as a target', () => {
    expect(() => validateSwapQuote(candidate({ to: LEGACY_PROXY }), expectation())).toThrow(/not an approved execution target/);
  });

  it('25. the legacy proxy is not on the allowlist in any role', () => {
    expect(TARGETS.universalRouters.map((a) => a.toLowerCase())).not.toContain(LEGACY_PROXY.toLowerCase());
    expect(TARGETS.swapProxies.map((a) => a.toLowerCase())).not.toContain(LEGACY_PROXY.toLowerCase());
  });

  it('an arbitrary API-returned router is rejected, even with perfectly valid calldata', () => {
    expect(() => validateSwapQuote(candidate({ to: UNVERIFIED_ROUTER }), expectation())).toThrow(/not an approved execution target/);
  });

  it('chainId must be 4663', () => {
    expect(() => validateSwapQuote(candidate({ chainId: 1 }), expectation())).toThrow(/chainId mismatch/);
  });

  it('value must be 0', () => {
    expect(() => validateSwapQuote(candidate({ value: '1' }), expectation())).toThrow(/"value" must be 0/);
  });
});

describe('4-6. permitData is advisory; the CALLDATA governs', () => {
  it('4/5. calldata with no PERMIT2_PERMIT command is accepted (whatever permitData said)', () => {
    const d = decodeUniversalRouterExecute(candidate().data);
    expect(d.commands).toEqual([0x00]); // V3_SWAP_EXACT_IN only
    expect(() => validateSwapQuote(candidate(), expectation())).not.toThrow();
  });

  it('6. calldata containing PERMIT2_PERMIT (0x0a) FAILS CLOSED -- no EIP-712 capability exists', () => {
    const data = urWithPermitCommand({ recipient: WALLET, tokenIn: TOKEN, amountIn: AMOUNT, amountOutMin: 8156n });
    expect(() => validateSwapQuote(candidate({ data }), expectation())).toThrow(/PERMIT2_PERMIT.*EIP-712/);
  });

  it('6b. PERMIT2_PERMIT_BATCH (0x03) is refused for the same reason', () => {
    const data = urExecuteCalldata({ recipient: WALLET, tokenIn: TOKEN, amountIn: AMOUNT, commands: '0x0300', extraInputs: ['0x00'] });
    expect(() => validateSwapQuote(candidate({ data }), expectation())).toThrow(/PERMIT2_PERMIT_BATCH/);
  });

  it('6c. the permit command is refused even with flag bits set in its high bits', () => {
    const data = urExecuteCalldata({ recipient: WALLET, tokenIn: TOKEN, amountIn: AMOUNT, commands: '0x8a00', extraInputs: ['0x00'] });
    expect(() => validateSwapQuote(candidate({ data }), expectation())).toThrow(/PERMIT2_PERMIT/);
  });

  it('an unknown / unreasoned-about command is refused, not tolerated', () => {
    const data = urExecuteCalldata({ recipient: WALLET, tokenIn: TOKEN, amountIn: AMOUNT, commands: '0x0005', extraInputs: ['0x00'] }); // TRANSFER
    expect(() => validateSwapQuote(candidate({ data }), expectation())).toThrow(/not an allowed exit-swap command/);
  });
});

describe('7-11. swap parameters must match the position and the quote', () => {
  it('7. the token sold matches the position token', () => {
    expect(() => validateSwapQuote(candidate(), expectation({ tokenIn: TOKEN }))).not.toThrow();
  });

  it('8. a token mismatch is rejected', () => {
    expect(() => validateSwapQuote(candidate(), expectation({ tokenIn: OTHER_TOKEN }))).toThrow(/sells token .* but this swap was quoted for/);
  });

  it('9. an amount mismatch inside the calldata is rejected, even when the API echo matches', () => {
    const data = urExecuteCalldata({ recipient: WALLET, tokenIn: TOKEN, amountIn: AMOUNT - 1n, amountOutMin: 8156n });
    expect(() => validateSwapQuote(candidate({ data }), expectation())).toThrow(/swap legs sell .* in total .* but exactly .* was requested/);
  });

  it('10. payerIsUser=false is rejected -- it does not describe a swap paid from the wallet', () => {
    const data = urExecuteCalldata({ recipient: WALLET, tokenIn: TOKEN, amountIn: AMOUNT, payerIsUser: false, amountOutMin: 8156n });
    expect(() => validateSwapQuote(candidate({ data }), expectation())).toThrow(/payerIsUser=false/);
  });

  it('output sent to anyone but the executor wallet is rejected', () => {
    const data = urExecuteCalldata({ recipient: '0x1111111111111111111111111111111111111111', tokenIn: TOKEN, amountIn: AMOUNT, amountOutMin: 8156n });
    expect(() => validateSwapQuote(candidate({ data }), expectation())).toThrow(/sends output to/);
  });

  it('a zero amountOutMin is rejected when min-received protection is on', () => {
    const data = urExecuteCalldata({ recipient: WALLET, tokenIn: TOKEN, amountIn: AMOUNT, amountOutMin: 0n });
    expect(() => validateSwapQuote(candidate({ data }), expectation())).toThrow(/zero amountOutMin/);
  });

  it('an expired router deadline is rejected', () => {
    const data = urExecuteCalldata({ recipient: WALLET, tokenIn: TOKEN, amountIn: AMOUNT, amountOutMin: 8156n, deadline: BigInt(NOW - 60) });
    expect(() => validateSwapQuote(candidate({ data }), expectation())).toThrow(/deadline .* already in the past/);
  });

  it('the existing min-received rule on the quote itself is still enforced', () => {
    expect(() => validateSwapQuote(candidate({ minOutputAmountRaw: 0n }), expectation())).toThrow(SwapQuoteValidationError);
  });

  describe('11. malformed Universal Router calldata fails closed', () => {
    it.each([
      ['wrong selector', '0xdeadbeef00'],
      ['bare selector, no batch', '0x3593564c'],
      ['truncated body', '0x3593564c0000000000000000000000000000000000000000000000000000000000000060'],
    ])('%s', (_label, data) => {
      expect(() => validateSwapQuote(candidate({ data }), expectation())).toThrow(SwapQuoteValidationError);
    });

    it('command/input count mismatch', () => {
      const abi = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline)']);
      const data = encodeFunctionData({ abi, functionName: 'execute', args: ['0x0000', [encodeAbiParameters([{ type: 'uint256' }], [1n])], BigInt(NOW + 600)] });
      expect(() => assertUniversalRouterCallSafe(data, { tokenIn: TOKEN, amountInRaw: AMOUNT, minOutputAmountRaw: 1n, minReceivedRequired: true, recipient: WALLET, now: NOW })).toThrow(/count mismatch/);
    });

    it('empty command list', () => {
      const abi = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline)']);
      const data = encodeFunctionData({ abi, functionName: 'execute', args: ['0x', [], BigInt(NOW + 600)] });
      expect(() => decodeUniversalRouterExecute(data)).toThrow(UniversalRouterCalldataError);
    });

    it('a direct router call cannot be validated without recipient and time -- refused, not skipped', () => {
      expect(() => validateSwapQuote(candidate(), { ...expectation(), recipient: undefined, now: undefined })).toThrow(/cannot be validated without/);
    });
  });
});

describe('26. the allowlist is unchanged by this work', () => {
  it('the AUDITED defaults for chain 4663 are exactly the two addresses, and neither known-bad one', () => {
    // Asserted against constants, not the resolved config: tests/setup.ts merges a
    // test-only router through the legacy env var, which production does not set.
    const audited = EXECUTION_TARGETS[4663]!;
    expect(audited.universalRouters).toEqual(['0x8876789976dEcBfCbBbe364623C63652db8C0904']);
    expect(audited.swapProxies).toEqual(['0x0000000085E102724e78eCd2F45DC9cA239Affad']);
    const all = [...audited.universalRouters, ...audited.swapProxies].map((a) => a.toLowerCase());
    expect(all).not.toContain(LEGACY_PROXY.toLowerCase());
    expect(all).not.toContain(UNVERIFIED_ROUTER.toLowerCase());
  });
});

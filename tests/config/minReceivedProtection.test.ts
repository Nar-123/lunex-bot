import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, type Address } from 'viem';
import { envSchema } from '../../src/config/env';
import { assertUniversalRouterCallSafe } from '../../src/swap/universalRouterCalldata';
import { config } from '../../src/config';

/**
 * HIGH-2: D8 FIX 4 (the aggregate `amountOutMin` bound) is gated by
 * `EXIT_MIN_RECEIVED_PROTECTION_ENABLED`, whose shipped default is OFF. The
 * final pre-deployment audit found production running with it OFF, which leaves
 * the bound dormant -- per-leg `> 0` still applies, but the legs' minimums are
 * never summed against the policy floor.
 *
 * This file pins the three things that make that safe to rely on:
 *   1. the env flag parses to a real boolean in both directions;
 *   2. the flag is what switches the validator's aggregate bound on and off;
 *   3. nothing in `src/` hardcodes it -- the value always comes from env.
 *
 * It deliberately does NOT assert which value production currently uses (that
 * is deployment configuration, asserted in `config.smoke.test.ts`), and it does
 * not change any behaviour.
 */

const BASE_VALID_ENV: Record<string, string> = {
  RPC_URL: 'https://test-rpc.invalid',
  CHAIN_ID: '4663',
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  USDG_TOKEN_ADDRESS: '0x' + '22'.repeat(20),
  DATABASE_URL: 'file:./data/test.db',
  AUTH_ADMIN_USERNAME: 'test-admin',
  AUTH_ADMIN_PASSWORD_HASH: '$2b$12$' + 'a'.repeat(53),
  JWT_SECRET: 'test-jwt-secret-not-for-real-use',
  UNISWAP_API_KEY: 'test-uniswap-trading-api-key-not-for-real-use',
  CANARY_MAX_POSITION_PCT: '0.01',
};

describe('HIGH-2: EXIT_MIN_RECEIVED_PROTECTION_ENABLED parsing', () => {
  it('"true" enables protection, "false" disables it, and the shipped default is OFF', () => {
    expect(envSchema.parse({ ...BASE_VALID_ENV, EXIT_MIN_RECEIVED_PROTECTION_ENABLED: 'true' }).EXIT_MIN_RECEIVED_PROTECTION_ENABLED).toBe(true);
    expect(envSchema.parse({ ...BASE_VALID_ENV, EXIT_MIN_RECEIVED_PROTECTION_ENABLED: 'false' }).EXIT_MIN_RECEIVED_PROTECTION_ENABLED).toBe(false);
    expect(envSchema.parse(BASE_VALID_ENV).EXIT_MIN_RECEIVED_PROTECTION_ENABLED).toBe(false);
  });

  it('a non-boolean string is rejected rather than silently coerced', () => {
    for (const bad of ['TRUE', '1', 'yes', 'on', '']) {
      expect(() => envSchema.parse({ ...BASE_VALID_ENV, EXIT_MIN_RECEIVED_PROTECTION_ENABLED: bad })).toThrow();
    }
  });

  it('the flag is wired straight through to the exits rule the validator reads', () => {
    // typeof, not a value assertion: the deployed value is configuration.
    expect(typeof config.rules.exits.MIN_RECEIVED_PROTECTION_ENABLED).toBe('boolean');
    const constants = readFileSync(path.resolve(__dirname, '../../src/config/constants.ts'), 'utf8');
    expect(constants).toMatch(/MIN_RECEIVED_PROTECTION_ENABLED:\s*env\.EXIT_MIN_RECEIVED_PROTECTION_ENABLED/);
  });

  it('nothing in src/ hardcodes the protection on or off', () => {
    const files = ['src/config/constants.ts', 'src/swap/tradingApiClient.ts', 'src/swap/validateSwapQuote.ts', 'src/swap/universalRouterCalldata.ts', 'src/exits/executeExit.ts'];
    for (const f of files) {
      const code = readFileSync(path.resolve(__dirname, '../..', f), 'utf8');
      expect(code, f).not.toMatch(/minReceivedRequired:\s*(true|false)\b/);
      expect(code, f).not.toMatch(/MIN_RECEIVED_PROTECTION_ENABLED\s*=\s*(true|false)\b/);
    }
    // the client passes the configured value, never a literal
    const client = readFileSync(path.resolve(__dirname, '../../src/swap/tradingApiClient.ts'), 'utf8');
    expect(client).toMatch(/minReceivedRequired:\s*config\.rules\.exits\.MIN_RECEIVED_PROTECTION_ENABLED/);
  });
});

describe('HIGH-2: the flag is what switches the aggregate bound', () => {
  const UR = getAddress(config.uniswapTradingApi.executionTargets.universalRouters[0]!);
  const USDG = getAddress(config.quoteAsset.ADDRESS);
  const TOKEN = '0x39dBED3a2bd333467115dE45665cC57F813C4571' as Address;
  const WALLET = '0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea' as Address;
  const NOW = Math.floor(Date.now() / 1000);
  const ABI = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline)']);
  /** One V3 exact-in leg selling TOKEN into USDG, guaranteeing `min`. */
  const leg = (amountIn: bigint, min: bigint): `0x${string}` =>
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
      [WALLET, amountIn, min, `0x${TOKEN.slice(2)}000bb8${USDG.slice(2)}`, true],
    );
  const data = encodeFunctionData({ abi: ABI, functionName: 'execute', args: ['0x00', [leg(1000n, 1n)], BigInt(NOW + 600)] });
  const expectation = { tokenIn: TOKEN, tokenOut: USDG, amountInRaw: 1000n, minOutputAmountRaw: 9000n, recipient: WALLET, now: NOW };

  it('ON: calldata guaranteeing only 1 wei against a 9000 policy floor is REFUSED', () => {
    expect(() => assertUniversalRouterCallSafe(data, { ...expectation, minReceivedRequired: true })).toThrow(/guarantee only 1 .*below the 9000/);
  });

  it('OFF: the same calldata passes -- the protection really is what the flag controls', () => {
    expect(() => assertUniversalRouterCallSafe(data, { ...expectation, minReceivedRequired: false })).not.toThrow();
  });

  it('OFF still refuses a ZERO per-leg minimum -- turning the flag off never removes the unbounded-leg check', () => {
    const zero = encodeFunctionData({ abi: ABI, functionName: 'execute', args: ['0x00', [leg(1000n, 0n)], BigInt(NOW + 600)] });
    expect(() => assertUniversalRouterCallSafe(zero, { ...expectation, minReceivedRequired: false })).toThrow(/zero amountOutMin/);
  });
});

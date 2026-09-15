import { describe, expect, it } from 'vitest';
import { formatUnits, parseUnits } from 'viem';
import { config } from '../../src/config';
import { envSchema } from '../../src/config/env';

describe('config.quoteAsset.DECIMALS -- Phase 12G fix (was wrongly 18, real on-chain USDG is 6)', () => {
  it('is exactly 6, matching the real on-chain USDG contract (0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) decimals() read', () => {
    expect(config.quoteAsset.DECIMALS).toBe(6);
  });

  it('CRITICAL: a human-readable amount of 1.0 USDG converts to 1_000_000 raw units, NOT 1_000_000_000_000_000_000 (the 18-decimal bug)', () => {
    const rawUnits = parseUnits('1.0', config.quoteAsset.DECIMALS);
    expect(rawUnits).toBe(1_000_000n);
    expect(rawUnits).not.toBe(1_000_000_000_000_000_000n);
  });

  it('round-trips human <-> raw exactly at the real 6-decimal scale', () => {
    const raw = parseUnits('350.5', config.quoteAsset.DECIMALS);
    expect(raw).toBe(350_500_000n);
    expect(formatUnits(raw, config.quoteAsset.DECIMALS)).toBe('350.5');
  });

  it('the env schema default is 6 when USDG_DECIMALS is not set at all -- the static fallback is correct even before the startup on-chain guard runs', () => {
    const result = envSchema.safeParse({
      RPC_URL: 'https://test-rpc.invalid',
      CHAIN_ID: '4663',
      PRIVATE_KEY: '0x' + '11'.repeat(32),
      USDG_TOKEN_ADDRESS: '0x' + '22'.repeat(20),
      DATABASE_URL: 'file:./data/test.db',
      AUTH_ADMIN_USERNAME: 'test-admin',
      AUTH_ADMIN_PASSWORD_HASH: '$2b$12$' + 'a'.repeat(53),
      JWT_SECRET: 'test-jwt-secret-not-for-real-use',
      UNISWAP_API_KEY: 'test-uniswap-trading-api-key-not-for-real-use',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.USDG_DECIMALS).toBe(6);
  });

  it('non-USDG assets are unaffected -- a candidate token still parses/formats at its OWN real decimals, independent of the USDG fix', () => {
    // A candidate token with 9 decimals (e.g. many meme tokens) must still
    // convert correctly -- this fix only ever touches USDG_DECIMALS /
    // config.quoteAsset.DECIMALS, never a generic/shared decimals default.
    const raw = parseUnits('42.123456789', 9);
    expect(raw).toBe(42_123_456_789n);
    expect(raw).not.toBe(parseUnits('42.123456789', config.quoteAsset.DECIMALS));
  });
});

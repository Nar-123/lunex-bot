import { describe, expect, it } from 'vitest';
import { applyCanaryPositionCap, canaryAllowsNewEntry, InMemoryCanaryGuard } from '../../src/capital/canary';
import type { CanaryRules } from '../../src/capital/canary';
import { decideCapitalAllocation } from '../../src/capital/decideCapitalAllocation';
import type { CapitalSnapshot, CapitalRules } from '../../src/capital/types';
import { config } from '../../src/config';
import { envSchema } from '../../src/config/env';

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
};

const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;

const DISABLED: CanaryRules = {
  enabled: false,
  maxPositionPct: null,
  maxUsdgRaw: null,
  maxPositions: 1,
  stopAfterSuccess: true,
};

describe('applyCanaryPositionCap -- disabled (production default)', () => {
  it('is a strict identity function when canary is disabled, regardless of what caps happen to be set', () => {
    const size = USDG(350);
    expect(applyCanaryPositionCap(size, USDG(1000), DISABLED)).toBe(size);
    expect(applyCanaryPositionCap(size, USDG(1000), { ...DISABLED, maxPositionPct: 0.01, maxUsdgRaw: USDG(1) })).toBe(size);
  });

  it('production sizing (decideCapitalAllocation -> 35% of free balance) is completely unaffected by canary being wired in', () => {
    const rules: CapitalRules = config.rules.capital;
    const snapshot: CapitalSnapshot = { freeUsdgBalance: USDG(1000), activePositionsCount: 0, totalDeployedUsdg: 0n };
    const decision = decideCapitalAllocation(snapshot, rules);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.positionSizeUsdgRaw).toBe(USDG(350));
    const final = applyCanaryPositionCap(decision.positionSizeUsdgRaw, snapshot.freeUsdgBalance, DISABLED);
    expect(final).toBe(USDG(350));
  });
});

describe('applyCanaryPositionCap -- enabled, synthetic test values', () => {
  it('caps to MAX_POSITION_PCT of free balance when that cap is the lower one', () => {
    const canary: CanaryRules = { enabled: true, maxPositionPct: 0.01, maxUsdgRaw: null, maxPositions: 1, stopAfterSuccess: true };
    // Uncapped decision would be 35% = 350 USDG; canary's 1% of 1000 = 10 USDG is lower.
    const result = applyCanaryPositionCap(USDG(350), USDG(1000), canary);
    expect(result).toBe(USDG(10));
  });

  it('caps to MAX_USDG when that absolute cap is the lower applicable limit', () => {
    const canary: CanaryRules = { enabled: true, maxPositionPct: 0.5, maxUsdgRaw: USDG(5), maxPositions: 1, stopAfterSuccess: true };
    // 50% of 1000 = 500 USDG (pct cap), but the absolute 5 USDG cap is lower.
    const result = applyCanaryPositionCap(USDG(500), USDG(1000), canary);
    expect(result).toBe(USDG(5));
  });

  it('MAX_USDG is never exceeded even when it is the ONLY configured cap', () => {
    const canary: CanaryRules = { enabled: true, maxPositionPct: null, maxUsdgRaw: USDG(25), maxPositions: 1, stopAfterSuccess: true };
    const result = applyCanaryPositionCap(USDG(350), USDG(1000), canary);
    expect(result).toBeLessThanOrEqual(USDG(25));
    expect(result).toBe(USDG(25));
  });

  it('the cap can never INCREASE the size decideCapitalAllocation already approved -- only narrow it', () => {
    // Canary caps set deliberately HIGHER than the already-decided size --
    // the result must stay at the original (lower) size, never grow to meet the cap.
    const canary: CanaryRules = { enabled: true, maxPositionPct: 0.9, maxUsdgRaw: USDG(10_000), maxPositions: 1, stopAfterSuccess: true };
    const alreadyDecided = USDG(350); // e.g. 35% of a 1000 USDG free balance
    const result = applyCanaryPositionCap(alreadyDecided, USDG(1000), canary);
    expect(result).toBe(alreadyDecided);
  });

  it('uses the LOWER of the two applicable limits when both are set and both would otherwise apply', () => {
    const lowerIsPct: CanaryRules = { enabled: true, maxPositionPct: 0.001, maxUsdgRaw: USDG(1000), maxPositions: 1, stopAfterSuccess: true };
    expect(applyCanaryPositionCap(USDG(350), USDG(1000), lowerIsPct)).toBe(USDG(1)); // 0.1% of 1000

    const lowerIsUsdg: CanaryRules = { enabled: true, maxPositionPct: 0.9, maxUsdgRaw: USDG(2), maxPositions: 1, stopAfterSuccess: true };
    expect(applyCanaryPositionCap(USDG(350), USDG(1000), lowerIsUsdg)).toBe(USDG(2));
  });
});

describe('canaryAllowsNewEntry -- max positions = 1 / one-shot latch', () => {
  it('always allows entry when canary is disabled, regardless of how many "canary" successes are recorded', () => {
    expect(canaryAllowsNewEntry(DISABLED, 0)).toBe(true);
    expect(canaryAllowsNewEntry(DISABLED, 5)).toBe(true);
  });

  it('allows exactly the first entry when enabled and nothing has succeeded yet', () => {
    const canary: CanaryRules = { enabled: true, maxPositionPct: 0.01, maxUsdgRaw: null, maxPositions: 1, stopAfterSuccess: true };
    expect(canaryAllowsNewEntry(canary, 0)).toBe(true);
  });

  it('blocks a second entry once one canary success has already been recorded', () => {
    const canary: CanaryRules = { enabled: true, maxPositionPct: 0.01, maxUsdgRaw: null, maxPositions: 1, stopAfterSuccess: true };
    expect(canaryAllowsNewEntry(canary, 1)).toBe(false);
    expect(canaryAllowsNewEntry(canary, 2)).toBe(false);
  });
});

describe('env.ts -- CANARY_ENABLED requires an operator-defined numeric cap', () => {
  it('CANARY_ENABLED=true with NEITHER cap set fails startup validation loudly -- never silently defaults to the full production size', () => {
    const result = envSchema.safeParse({ ...BASE_VALID_ENV, CANARY_ENABLED: 'true' });
    expect(result.success).toBe(false);
  });

  it('CANARY_ENABLED=true with only CANARY_MAX_POSITION_PCT set is accepted', () => {
    const result = envSchema.safeParse({ ...BASE_VALID_ENV, CANARY_ENABLED: 'true', CANARY_MAX_POSITION_PCT: '0.01' });
    expect(result.success).toBe(true);
  });

  it('CANARY_ENABLED=true with only CANARY_MAX_USDG set is accepted', () => {
    const result = envSchema.safeParse({ ...BASE_VALID_ENV, CANARY_ENABLED: 'true', CANARY_MAX_USDG: '50' });
    expect(result.success).toBe(true);
  });

  it('CANARY_MAX_POSITION_PCT rejects exactly 0 (must be strictly > 0)', () => {
    const result = envSchema.safeParse({ ...BASE_VALID_ENV, CANARY_MAX_POSITION_PCT: '0' });
    expect(result.success).toBe(false);
  });

  it('CANARY_MAX_POSITION_PCT rejects negative values', () => {
    const result = envSchema.safeParse({ ...BASE_VALID_ENV, CANARY_MAX_POSITION_PCT: '-0.1' });
    expect(result.success).toBe(false);
  });

  it('CANARY_MAX_POSITION_PCT accepts a small positive fraction just above 0', () => {
    const result = envSchema.safeParse({ ...BASE_VALID_ENV, CANARY_MAX_POSITION_PCT: '0.0001' });
    expect(result.success).toBe(true);
  });

  it('CANARY_MAX_POSITION_PCT accepts exactly 1 (the inclusive upper bound)', () => {
    const result = envSchema.safeParse({ ...BASE_VALID_ENV, CANARY_MAX_POSITION_PCT: '1' });
    expect(result.success).toBe(true);
  });

  it('CANARY_MAX_POSITION_PCT rejects values above 1', () => {
    const result = envSchema.safeParse({ ...BASE_VALID_ENV, CANARY_MAX_POSITION_PCT: '1.01' });
    expect(result.success).toBe(false);
  });

  it('CANARY_MAX_USDG rejects exactly 0 (must be strictly > 0)', () => {
    const result = envSchema.safeParse({ ...BASE_VALID_ENV, CANARY_MAX_USDG: '0' });
    expect(result.success).toBe(false);
  });

  it('CANARY_MAX_USDG rejects negative values', () => {
    const result = envSchema.safeParse({ ...BASE_VALID_ENV, CANARY_MAX_USDG: '-5' });
    expect(result.success).toBe(false);
  });

  it('CANARY_MAX_USDG accepts a positive value and reads it back correctly', () => {
    const result = envSchema.safeParse({ ...BASE_VALID_ENV, CANARY_MAX_USDG: '50' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.CANARY_MAX_USDG).toBe(50);
  });

  it('CANARY_MAX_POSITION_PCT reads back the exact configured fraction, unmodified', () => {
    const result = envSchema.safeParse({ ...BASE_VALID_ENV, CANARY_MAX_POSITION_PCT: '0.02' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.CANARY_MAX_POSITION_PCT).toBe(0.02);
  });

  it('CANARY_ENABLED=false (the default) never requires either cap', () => {
    const result = envSchema.safeParse(BASE_VALID_ENV);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.CANARY_ENABLED).toBe(false);
      expect(result.data.CANARY_MAX_POSITION_PCT).toBeUndefined();
      expect(result.data.CANARY_MAX_USDG).toBeUndefined();
    }
  });
});

describe('config.rules.canary -- fixed (non-operator-tunable) fields', () => {
  it('MAX_POSITIONS is fixed at 1 -- not exposed as an env-configurable value', () => {
    expect(config.rules.canary.MAX_POSITIONS).toBe(1);
  });

  it('STOP_AFTER_SUCCESS is fixed at true -- not exposed as an env-configurable value', () => {
    expect(config.rules.canary.STOP_AFTER_SUCCESS).toBe(true);
  });

  it('ENABLED is false in this test environment (no CANARY_ENABLED set)', () => {
    expect(config.rules.canary.ENABLED).toBe(false);
  });

  it('production CAPITAL.POSITION_SIZE_PCT_OF_FREE_BALANCE remains 0.35, untouched by the canary block existing', () => {
    expect(config.rules.capital.POSITION_SIZE_PCT_OF_FREE_BALANCE).toBe(0.35);
  });
});

describe('InMemoryCanaryGuard -- cross-cycle latch state', () => {
  it('starts at zero successes', () => {
    const guard = new InMemoryCanaryGuard();
    expect(guard.succeededCount()).toBe(0);
  });

  it('records a success and reflects it in succeededCount', () => {
    const guard = new InMemoryCanaryGuard();
    guard.recordSuccess();
    expect(guard.succeededCount()).toBe(1);
  });

  it('composed with canaryAllowsNewEntry: second entry is blocked after the first successful canary state', () => {
    const canary: CanaryRules = { enabled: true, maxPositionPct: 0.01, maxUsdgRaw: null, maxPositions: 1, stopAfterSuccess: true };
    const guard = new InMemoryCanaryGuard();

    expect(canaryAllowsNewEntry(canary, guard.succeededCount())).toBe(true); // before any success
    guard.recordSuccess(); // the one allowed canary position opens
    expect(canaryAllowsNewEntry(canary, guard.succeededCount())).toBe(false); // second entry blocked
  });
});

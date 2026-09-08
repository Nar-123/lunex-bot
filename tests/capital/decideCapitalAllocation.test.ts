import { describe, expect, it } from 'vitest';
import { decideCapitalAllocation, checkEthGasReserve } from '../../src/capital/decideCapitalAllocation';
import type { CapitalSnapshot, CapitalRules } from '../../src/capital/types';
import { config } from '../../src/config';

const USDG = (n: number): bigint => BigInt(n) * 10n ** 18n;
/** Same shape `screeningCycle.ts` builds every cycle (frozen config, no live-settings override) -- the default every pre-existing test in this file exercises. */
const RULES: CapitalRules = config.rules.capital;

function baseSnapshot(overrides: Partial<CapitalSnapshot> = {}): CapitalSnapshot {
  return {
    freeUsdgBalance: USDG(1000),
    activePositionsCount: 0,
    totalDeployedUsdg: 0n,
    ...overrides,
  };
}

describe('decideCapitalAllocation -- position sizing (35% of FREE balance)', () => {
  it('sizes the position at exactly 35% of free USDG balance', () => {
    const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(1000) }), RULES);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.positionSizeUsdgRaw).toBe(USDG(350));
  });

  it('sizes from FREE balance, not from any notion of an original/starting balance', () => {
    // Same free balance, very different totalDeployedUsdg (representing a
    // very different "starting balance" history) -- must not affect sizing.
    const fresh = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(1000), totalDeployedUsdg: 0n }), RULES);
    const seasoned = decideCapitalAllocation(
      baseSnapshot({ freeUsdgBalance: USDG(1000), totalDeployedUsdg: USDG(5000), activePositionsCount: 1 }),
      RULES,
    );
    expect(fresh.ok).toBe(true);
    expect(seasoned.ok).toBe(true);
    if (fresh.ok && seasoned.ok) {
      expect(fresh.positionSizeUsdgRaw).toBe(seasoned.positionSizeUsdgRaw);
    }
  });

  it('rejects when free balance is zero (nothing to deploy)', () => {
    const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: 0n }), RULES);
    expect(result.ok).toBe(false);
  });
});

describe('decideCapitalAllocation -- max active positions (3)', () => {
  it('allows deployment with 0, 1, or 2 active positions', () => {
    for (const count of [0, 1, 2]) {
      const result = decideCapitalAllocation(baseSnapshot({ activePositionsCount: count }), RULES);
      expect(result.ok).toBe(true);
    }
  });

  it('rejects at exactly 3 active positions (the boundary)', () => {
    const result = decideCapitalAllocation(baseSnapshot({ activePositionsCount: 3 }), RULES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/max active positions/i);
  });

  it('rejects above 3 active positions too', () => {
    const result = decideCapitalAllocation(baseSnapshot({ activePositionsCount: 4 }), RULES);
    expect(result.ok).toBe(false);
  });
});

describe('decideCapitalAllocation -- max total deployed (90% hard cap)', () => {
  it('allows a deployment that lands exactly at the 90% cap (inclusive boundary)', () => {
    // freeUsdgBalance=1000, totalDeployedUsdg=550 -> portfolio=1550,
    // 90% cap=1395. New position = 35% of 1000 = 350.
    // projected deployed = 550+350 = 900... let's pick numbers that land exactly on the cap instead.
    // portfolio P, want projected == 0.9P. positionSize = 0.35*free.
    // Choose free=1000 (position=350), deployed=D such that D+350 = 0.9*(1000+D)
    // => D + 350 = 900 + 0.9D => 0.1D = 550 => D = 5500
    const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(1000), totalDeployedUsdg: USDG(5500) }), RULES);
    expect(result.ok).toBe(true);
  });

  it('rejects a deployment that would push total deployed just past the 90% cap', () => {
    const result = decideCapitalAllocation(
      baseSnapshot({ freeUsdgBalance: USDG(1000), totalDeployedUsdg: USDG(5501) }),
      RULES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/90% cap/);
  });

  it('rejects when already fully deployed (free balance tiny relative to huge existing deployment)', () => {
    const result = decideCapitalAllocation(
      baseSnapshot({ freeUsdgBalance: USDG(1), totalDeployedUsdg: USDG(100_000), activePositionsCount: 2 }),
      RULES,
    );
    expect(result.ok).toBe(false);
  });
});

describe('decideCapitalAllocation -- ETH gas reserve (default OFF, per spec explicitly TBD)', () => {
  it('is not enforced by default even when ethBalance is entirely absent', () => {
    const result = decideCapitalAllocation(baseSnapshot(), RULES);
    expect(result.ok).toBe(true);
  });
});

describe('checkEthGasReserve -- tested directly since the config toggle cannot be flipped per-test', () => {
  it('passes trivially when disabled, regardless of balance', () => {
    expect(checkEthGasReserve(undefined, false, 1)).toEqual({ ok: true });
    expect(checkEthGasReserve(0n, false, 100)).toEqual({ ok: true });
  });

  it('rejects when enabled but no ETH balance was supplied', () => {
    const result = checkEthGasReserve(undefined, true, 0.05);
    expect(result.ok).toBe(false);
  });

  it('rejects when enabled and balance is below the reserve', () => {
    const result = checkEthGasReserve(10n ** 16n /* 0.01 ETH */, true, 0.05);
    expect(result.ok).toBe(false);
  });

  it('passes when enabled and balance meets or exceeds the reserve', () => {
    const exact = checkEthGasReserve(5n * 10n ** 16n /* 0.05 ETH exactly */, true, 0.05);
    expect(exact.ok).toBe(true);
    const above = checkEthGasReserve(10n ** 18n /* 1 ETH */, true, 0.05);
    expect(above.ok).toBe(true);
  });

  it('treats reserveMin = 0 as always satisfied when enabled', () => {
    expect(checkEthGasReserve(0n, true, 0)).toEqual({ ok: true });
  });
});

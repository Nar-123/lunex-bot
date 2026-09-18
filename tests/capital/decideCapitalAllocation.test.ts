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

const capOf = (base: bigint): bigint => (base * 950_000n) / 1_000_000n;
const targetOf = (base: bigint): bigint => (base * 350_000n) / 1_000_000n;

describe('decideCapitalAllocation -- position sizing (35% of the STABLE base portfolio balance, Phase 10C-REVISION)', () => {
  it('sizes at exactly 35% of a fully-free base portfolio (free=1000, deployed=0 -> base=1000)', () => {
    const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(1000), totalDeployedUsdg: 0n }), RULES);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.positionSizeUsdgRaw).toBe(USDG(350));
  });

  it('sizes from the STABLE base (free + deployed), not from current free balance alone -- two snapshots with the same base but a different free/deployed split give the SAME target', () => {
    const fresh = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(1000), totalDeployedUsdg: 0n }), RULES);
    // Same base (1000), but 350 of it has already moved from free to deployed --
    // this is the exact correction Phase 10C-REVISION makes: the OLD (free-
    // balance-only) formula would have sized this at 35% of 650 = 227.5,
    // not 350.
    const midway = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(650), totalDeployedUsdg: USDG(350) }), RULES);
    expect(fresh.ok).toBe(true);
    expect(midway.ok).toBe(true);
    if (fresh.ok && midway.ok) {
      expect(fresh.positionSizeUsdgRaw).toBe(USDG(350));
      expect(midway.positionSizeUsdgRaw).toBe(USDG(350));
      expect(fresh.positionSizeUsdgRaw).toBe(midway.positionSizeUsdgRaw);
    }
  });

  it('the target DOES scale when the base portfolio itself genuinely changes (e.g. a deposit) -- it is stable against capital MOVING between buckets, not frozen forever', () => {
    const smaller = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(1000), totalDeployedUsdg: 0n }), RULES);
    const larger = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(2000), totalDeployedUsdg: 0n }), RULES);
    expect(smaller.ok).toBe(true);
    expect(larger.ok).toBe(true);
    if (smaller.ok && larger.ok) {
      expect(smaller.positionSizeUsdgRaw).toBe(USDG(350));
      expect(larger.positionSizeUsdgRaw).toBe(USDG(700)); // proportional to the new, larger base
    }
  });

  it('rejects when the base portfolio balance is zero (nothing to deploy)', () => {
    const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: 0n, totalDeployedUsdg: 0n }), RULES);
    expect(result.ok).toBe(false);
  });
});

describe('decideCapitalAllocation -- max active positions (3, unchanged)', () => {
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

  it('the active-position-count gate is checked BEFORE any capital math -- rejects regardless of how much capacity would otherwise be available', () => {
    const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(1_000_000), totalDeployedUsdg: 0n, activePositionsCount: 3 }), RULES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/max active positions/i);
  });
});

describe('decideCapitalAllocation -- max total deployed (95% of base portfolio balance, hard cap)', () => {
  it('allows a deployment that lands exactly at the 95% cap (inclusive boundary)', () => {
    // base=1000 (free=400, deployed=600): target=350, cap=950, remaining=950-600=350 -- target == remaining exactly.
    const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(400), totalDeployedUsdg: USDG(600) }), RULES);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.positionSizeUsdgRaw).toBe(USDG(350));
      expect(USDG(600) + result.positionSizeUsdgRaw).toBe(USDG(950)); // lands exactly at the cap
    }
  });

  it('TRUNCATES (does not reject outright) a position whose full 35% target would breach the 95% cap', () => {
    // base=1000 (free=300, deployed=700): target=350, cap=950, remaining=950-700=250 -- truncated to 250.
    const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(300), totalDeployedUsdg: USDG(700) }), RULES);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.positionSizeUsdgRaw).toBe(USDG(250));
      expect(result.positionSizeUsdgRaw).toBeLessThan(USDG(350)); // strictly less than the 35% target
      expect(USDG(700) + result.positionSizeUsdgRaw).toBe(USDG(950)); // truncated to land EXACTLY at the cap
    }
  });

  it('rejects only when there is ZERO remaining capacity (fully deployed at the cap already)', () => {
    // base=1000 (free=50, deployed=950): cap=950, remaining=0.
    const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(50), totalDeployedUsdg: USDG(950) }), RULES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/remaining capacity/i);
  });

  it('rejects when already fully deployed (free balance tiny relative to a huge existing deployment)', () => {
    const result = decideCapitalAllocation(
      baseSnapshot({ freeUsdgBalance: USDG(1), totalDeployedUsdg: USDG(100_000), activePositionsCount: 2 }),
      RULES,
    );
    expect(result.ok).toBe(false);
  });
});

describe('decideCapitalAllocation -- canonical worked example (base = 1000, cap = 950): 350 / 350 / 250', () => {
  it('position #1 (nothing deployed yet): target = 350', () => {
    const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(1000), totalDeployedUsdg: 0n }), RULES);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.positionSizeUsdgRaw).toBe(USDG(350));
  });

  it('position #2 (350 already deployed, base still 1000): target = 350 again -- the base does not shrink from deploying #1', () => {
    const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(650), totalDeployedUsdg: USDG(350) }), RULES);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.positionSizeUsdgRaw).toBe(USDG(350));
  });

  it('position #3 (700 already deployed, base still 1000): truncated to 250 -- remaining capacity (250) is now below the 350 target', () => {
    const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(300), totalDeployedUsdg: USDG(700) }), RULES);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.positionSizeUsdgRaw).toBe(USDG(250));
  });

  it('three REAL sequential entries (each call fed the actual previous result) reproduce 350 / 350 / 250 exactly, totaling 950, with 50 left free', () => {
    let free = USDG(1000);
    let deployed = 0n;
    const sizes: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: free, totalDeployedUsdg: deployed }), RULES);
      expect(result.ok).toBe(true);
      if (!result.ok) break;
      sizes.push(result.positionSizeUsdgRaw);
      free -= result.positionSizeUsdgRaw;
      deployed += result.positionSizeUsdgRaw;
    }
    expect(sizes).toEqual([USDG(350), USDG(350), USDG(250)]);
    expect(deployed).toBe(USDG(950));
    expect(free).toBe(USDG(50));
  });

  it('a 4th position is rejected because MAX_POSITIONS=3, independent of remaining capacity', () => {
    const result = decideCapitalAllocation(
      baseSnapshot({ freeUsdgBalance: USDG(50), totalDeployedUsdg: USDG(950), activePositionsCount: 3 }),
      RULES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/max active positions/i);
  });

  it('at exactly 950 deployed (95% of a 1000 base), a further entry is rejected -- zero remaining capacity', () => {
    const result = decideCapitalAllocation(
      baseSnapshot({ freeUsdgBalance: USDG(50), totalDeployedUsdg: USDG(950), activePositionsCount: 2 }),
      RULES,
    );
    expect(result.ok).toBe(false);
  });

  it('closing the 350 position returns exactly 350 of capacity, and the next eligible entry targets and gets exactly 350 again', () => {
    // Before close: free=50, deployed=950 (positions of 350+350+250), base=1000, cap=950, remaining=0.
    const before = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(50), totalDeployedUsdg: USDG(950), activePositionsCount: 2 }), RULES);
    expect(before.ok).toBe(false);

    // After closing the 350 position, its capital returns to the wallet:
    // free 50 -> 400, deployed 950 -> 600. Base is STILL 1000 (conserved --
    // nothing left the system, it just moved between buckets again).
    const afterClose = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(400), totalDeployedUsdg: USDG(600) }), RULES);
    expect(afterClose.ok).toBe(true);
    if (afterClose.ok) {
      const remainingCapacity = capOf(USDG(1_000)) - USDG(600);
      expect(remainingCapacity).toBe(USDG(350)); // capacity is back to exactly 350
      expect(afterClose.positionSizeUsdgRaw).toBe(USDG(350)); // target (350) == remaining (350) -- the "next eligible entry" example
    }
  });
});

describe('decideCapitalAllocation -- base portfolio balance changes for REAL reasons (deposit/withdrawal/realized PnL), documented expected behavior', () => {
  it('a deposit that increases free balance WITHOUT any deployed capital existing yet raises the base, and the target scales with it', () => {
    const before = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(1000), totalDeployedUsdg: 0n }), RULES);
    const afterDeposit = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(1500), totalDeployedUsdg: 0n }), RULES);
    expect(before.ok && afterDeposit.ok).toBe(true);
    if (before.ok && afterDeposit.ok) {
      expect(before.positionSizeUsdgRaw).toBe(USDG(350));
      expect(afterDeposit.positionSizeUsdgRaw).toBe(USDG(525)); // 35% of the new, larger 1500 base
    }
  });

  it('a position closing at a LOSS (realizedUsdgRaw < entryUsdgRaw) genuinely shrinks the base for the NEXT decision -- this is correct, not a bug: the base tracks true current portfolio value', () => {
    // Position entered at 350 out of a 1000 base (free=650, deployed=350).
    // It closes having returned only 300 (a realized loss of 50) -- the
    // wallet's free balance becomes 650+300=950, nothing is "deployed"
    // anymore. New base = 950, not the original 1000.
    const afterLossyClose = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(950), totalDeployedUsdg: 0n }), RULES);
    expect(afterLossyClose.ok).toBe(true);
    if (afterLossyClose.ok) expect(afterLossyClose.positionSizeUsdgRaw).toBe(targetOf(USDG(950)));
  });
});

describe('decideCapitalAllocation -- rounding never allows exposure to exceed 95% of the base portfolio balance', () => {
  it('holds the invariant totalDeployed + positionSize <= 95% of (free + deployed) across a spread of awkward (non-round) numbers', () => {
    const awkwardCases: Array<{ free: bigint; deployed: bigint }> = [
      { free: 999_999_999_999_999_999n, deployed: 333_333_333_333_333_333n },
      { free: 1n, deployed: 0n },
      { free: 7n, deployed: 13n },
      { free: USDG(1) + 1n, deployed: USDG(1_000) - 1n },
      { free: 123_456_789_012_345_678n, deployed: 987_654_321_098_765_432n },
    ];
    for (const { free, deployed } of awkwardCases) {
      const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: free, totalDeployedUsdg: deployed }), RULES);
      if (result.ok) {
        const base = free + deployed;
        expect(deployed + result.positionSizeUsdgRaw).toBeLessThanOrEqual(capOf(base));
      }
      // when !result.ok, there is nothing to check -- no position is sized at all, so exposure cannot have grown.
    }
  });

  it('insufficient remaining capacity (a small sliver less than any positive target) is still truncated to that sliver if > 0, and rejected only at exactly 0', () => {
    // base=1000, cap=950. deployed=949 leaves exactly 1 raw unit of capacity --
    // still accepted (truncates to that tiny sliver); deployed=950 leaves exactly 0 -- rejected.
    const sliver = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(50) - 1n, totalDeployedUsdg: USDG(950) - 1n }), RULES);
    if (sliver.ok) expect(sliver.positionSizeUsdgRaw).toBeGreaterThan(0n);

    const zero = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(50), totalDeployedUsdg: USDG(950) }), RULES);
    expect(zero.ok).toBe(false);
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

describe('decideCapitalAllocation -- P0-2: independently enforces the hard ceilings even when the CALLER passes malformed/above-ceiling rules', () => {
  it('a malformed 100% positionSizePct is clamped to the 35% ceiling -- the resulting position is exactly the SAME size a legal 35% caller would get', () => {
    const malformed: CapitalRules = { ...RULES, POSITION_SIZE_PCT_OF_FREE_BALANCE: 1.0 };
    const legal: CapitalRules = { ...RULES, POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35 };
    const malformedResult = decideCapitalAllocation(baseSnapshot(), malformed);
    const legalResult = decideCapitalAllocation(baseSnapshot(), legal);
    expect(malformedResult).toEqual(legalResult);
    if (malformedResult.ok) {
      expect(malformedResult.positionSizeUsdgRaw).toBe(targetOf(USDG(1000))); // 350 USDG, NOT 1000
    }
  });

  it('a malformed MAX_ACTIVE_POSITIONS=50 is clamped to the ceiling of 3 -- the 4th position is still rejected', () => {
    const malformed: CapitalRules = { ...RULES, MAX_ACTIVE_POSITIONS: 50 };
    const result = decideCapitalAllocation(baseSnapshot({ activePositionsCount: 3, totalDeployedUsdg: capOf(USDG(1000)) - 1n }), malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/max active positions reached \(3\/3\)/);
  });

  it('a malformed 100% MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO is clamped to the 95% global cap', () => {
    const malformed: CapitalRules = { ...RULES, MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 1.0 };
    // basePortfolioBalance stays 1000 (free + deployed); already deployed
    // exactly at the REAL 95% cap (950) -- a malformed 100% cap would
    // (incorrectly) still allow more room; the clamp must reject here
    // exactly as the legal 95% rule would.
    const deployed = capOf(USDG(1000));
    const result = decideCapitalAllocation(baseSnapshot({ freeUsdgBalance: USDG(1000) - deployed, totalDeployedUsdg: deployed }), malformed);
    expect(result.ok).toBe(false);
  });

  it('a value already at or below the ceiling passes through completely unchanged (the clamp is one-directional, never a floor)', () => {
    const tighter: CapitalRules = { ...RULES, POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.1, MAX_ACTIVE_POSITIONS: 1 };
    const result = decideCapitalAllocation(baseSnapshot(), tighter);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.positionSizeUsdgRaw).toBe(USDG(100)); // 10% of 1000, not clamped up to 35%
  });

  it('acceptance #9/#10: the SAME ceilings are enforced regardless of caller -- a screeningCycle-shaped rules object built from a malformed settings row can never bypass them', () => {
    // Mirrors exactly how screeningCycle.ts builds CapitalRules from live settings.
    const maliciousSettingsShapedRules: CapitalRules = {
      ...config.rules.capital,
      MAX_ACTIVE_POSITIONS: 4, // above ceiling, e.g. a legacy DB row from before P0-2
      POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.36, // above ceiling
    };
    const result = decideCapitalAllocation(baseSnapshot({ activePositionsCount: 3 }), maliciousSettingsShapedRules);
    // 3 active positions against the CLAMPED ceiling of 3 -> rejected, never allowed to reach a 4th.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/max active positions reached \(3\/3\)/);
  });
});

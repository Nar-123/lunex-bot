import { describe, expect, it } from 'vitest';
import { CAPITAL_HARD_CEILINGS, clampToHardCeilings, exceedsHardCeilings } from '../../src/capital/hardCeilings';
import type { CapitalRules } from '../../src/capital/types';

const BASE_RULES: CapitalRules = {
  MAX_ACTIVE_POSITIONS: 3,
  POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35,
  MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.95,
  ETH_GAS_RESERVE_ENABLED: false,
  ETH_GAS_RESERVE_MIN: 0,
};

describe('CAPITAL_HARD_CEILINGS', () => {
  it('matches the documented Draft V1 / TIER 3 policy exactly', () => {
    expect(CAPITAL_HARD_CEILINGS.MAX_POSITION_SIZE_PCT).toBe(0.35);
    expect(CAPITAL_HARD_CEILINGS.MAX_ACTIVE_POSITIONS).toBe(3);
    expect(CAPITAL_HARD_CEILINGS.MAX_TOTAL_DEPLOYED_PCT).toBe(0.95);
  });
});

describe('clampToHardCeilings', () => {
  it('leaves rules already at the ceiling unchanged', () => {
    expect(clampToHardCeilings(BASE_RULES)).toEqual(BASE_RULES);
  });

  it('leaves rules below the ceiling unchanged (never a floor)', () => {
    const tighter: CapitalRules = { ...BASE_RULES, POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.1, MAX_ACTIVE_POSITIONS: 1, MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.5 };
    expect(clampToHardCeilings(tighter)).toEqual(tighter);
  });

  it('clamps positionSizePct down to 35% when above', () => {
    const malformed: CapitalRules = { ...BASE_RULES, POSITION_SIZE_PCT_OF_FREE_BALANCE: 1.0 };
    expect(clampToHardCeilings(malformed).POSITION_SIZE_PCT_OF_FREE_BALANCE).toBe(0.35);
  });

  it('clamps maxActivePositions down to 3 when above', () => {
    const malformed: CapitalRules = { ...BASE_RULES, MAX_ACTIVE_POSITIONS: 50 };
    expect(clampToHardCeilings(malformed).MAX_ACTIVE_POSITIONS).toBe(3);
  });

  it('clamps the global deployed cap down to 95% when above', () => {
    const malformed: CapitalRules = { ...BASE_RULES, MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 1.0 };
    expect(clampToHardCeilings(malformed).MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO).toBe(0.95);
  });

  it('never touches ETH_GAS_RESERVE_* fields -- only the three ceiling-governed fields', () => {
    const rules: CapitalRules = { ...BASE_RULES, ETH_GAS_RESERVE_ENABLED: true, ETH_GAS_RESERVE_MIN: 0.02 };
    const clamped = clampToHardCeilings(rules);
    expect(clamped.ETH_GAS_RESERVE_ENABLED).toBe(true);
    expect(clamped.ETH_GAS_RESERVE_MIN).toBe(0.02);
  });
});

describe('exceedsHardCeilings', () => {
  it('false when every field is at or below its ceiling', () => {
    expect(exceedsHardCeilings(BASE_RULES)).toBe(false);
  });

  it('true when positionSizePct alone exceeds', () => {
    expect(exceedsHardCeilings({ ...BASE_RULES, POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.36 })).toBe(true);
  });

  it('true when maxActivePositions alone exceeds', () => {
    expect(exceedsHardCeilings({ ...BASE_RULES, MAX_ACTIVE_POSITIONS: 4 })).toBe(true);
  });

  it('true when the global deployed cap alone exceeds', () => {
    expect(exceedsHardCeilings({ ...BASE_RULES, MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.96 })).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { config } from '../src/config';

describe('config', () => {
  it('loads and freezes spec-locked business rules', () => {
    expect(config.rules.filters.MIN_MARKET_CAP_USD).toBe(1_000_000);
    expect(config.rules.filters.MAX_TOP10_HOLDER_CONCENTRATION).toBe(0.4);
    expect(config.rules.capital.POSITION_SIZE_PCT_OF_FREE_BALANCE).toBe(0.35);
    expect(config.rules.capital.MAX_ACTIVE_POSITIONS).toBe(3);
    expect(config.rules.exits.HARD_STOP_LOSS_PCT).toBe(-0.06);
    // Validation phase: Low Yield is DISABLED BY DEFAULT -- Meridian's
    // metric is pool-level 24h fees/TVL and Lunex has no data source that
    // can reproduce it (audited in EXITS.LOW_YIELD's doc comment); no
    // substitute metric may be shipped under this rule's name. The rule's
    // parameters remain Meridian's measured values for when a real
    // fee/TVL feed exists.
    expect(config.rules.exits.LOW_YIELD.ENABLED).toBe(false);
    expect(config.rules.exits.LOW_YIELD.MIN_FEE_YIELD_PCT).toBe(0.0005);
    expect(config.rules.exits.LOW_YIELD.MIN_AGE_MS).toBe(30 * 60 * 1000);
  });

  it('defaults unlocked/TBD parameters to disabled, not a guessed value', () => {
    expect(config.rules.capital.ETH_GAS_RESERVE_ENABLED).toBe(false);
    expect(config.rules.capital.ETH_GAS_RESERVE_MIN).toBe(0);
    // Tier 3: the exit price-impact check is now ENABLED by default (0.5% cap).
    expect(config.rules.exits.IMPACT_CHECK_ENABLED).toBe(true);
    expect(config.rules.exits.MIN_RECEIVED_PROTECTION_ENABLED).toBe(false);
  });

  it('never enables the honeypot check as a filter', () => {
    expect(config.rules.filters.HONEYPOT_CHECK_INCLUDED).toBe(false);
  });
});

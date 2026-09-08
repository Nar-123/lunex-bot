import { describe, expect, it } from 'vitest';
import { config } from '../src/config';

describe('config', () => {
  it('loads and freezes spec-locked business rules', () => {
    expect(config.rules.filters.MIN_MARKET_CAP_USD).toBe(1_000_000);
    expect(config.rules.filters.MAX_TOP10_HOLDER_CONCENTRATION).toBe(0.4);
    expect(config.rules.capital.POSITION_SIZE_PCT_OF_FREE_BALANCE).toBe(0.35);
    expect(config.rules.capital.MAX_ACTIVE_POSITIONS).toBe(3);
    expect(config.rules.exits.HARD_STOP_LOSS_PCT).toBe(-0.15);
    expect(config.rules.exits.LOW_YIELD_EXIT_ENABLED).toBe(false);
  });

  it('defaults unlocked/TBD parameters to disabled, not a guessed value', () => {
    expect(config.rules.capital.ETH_GAS_RESERVE_ENABLED).toBe(false);
    expect(config.rules.capital.ETH_GAS_RESERVE_MIN).toBe(0);
    expect(config.rules.exits.IMPACT_CHECK_ENABLED).toBe(false);
    expect(config.rules.exits.MIN_RECEIVED_PROTECTION_ENABLED).toBe(false);
  });

  it('never enables the honeypot check as a filter', () => {
    expect(config.rules.filters.HONEYPOT_CHECK_INCLUDED).toBe(false);
  });
});

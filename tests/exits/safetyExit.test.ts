import { describe, expect, it } from 'vitest';
import {
  evaluateMetricsFailureSafetyExit,
  evaluateSafetyExit,
  isPoolPriceStructurallyInvalid,
  isSwapRetryStuck,
} from '../../src/exits/safetyExit';
import { config } from '../../src/config';
import { v3TickMathUtils } from '../../src/blockchain/uniswapSdk';
import type { PoolPriceState } from '../../src/monitoring/types';

const { TickMath } = v3TickMathUtils;

const T0 = new Date('2026-01-01T00:00:00.000Z');
const MAX_METRICS_FAILURE_MS = config.rules.exits.SAFETY_EXIT.MAX_METRICS_FAILURE_MS;

describe('Safety Exit condition (a): sustained metrics-read failure', () => {
  it('does not trigger when there is no failure streak (null)', () => {
    expect(evaluateMetricsFailureSafetyExit(null, T0)).toBe(false);
  });

  it('does not trigger just before the threshold', () => {
    const since = new Date(T0.getTime() - (MAX_METRICS_FAILURE_MS - 1));
    expect(evaluateMetricsFailureSafetyExit(since, T0)).toBe(false);
  });

  it('triggers at exactly the threshold -- this actually fires, not an empty category', () => {
    const since = new Date(T0.getTime() - MAX_METRICS_FAILURE_MS);
    expect(evaluateMetricsFailureSafetyExit(since, T0)).toBe(true);
  });

  it('triggers well past the threshold', () => {
    const since = new Date(T0.getTime() - MAX_METRICS_FAILURE_MS * 3);
    expect(evaluateMetricsFailureSafetyExit(since, T0)).toBe(true);
  });
});

describe('Safety Exit condition (b): structurally invalid pool price read', () => {
  const valid: PoolPriceState = { sqrtPriceX96: 2n ** 96n, tickCurrent: 0 };

  it('does not trigger for a normal, valid price state', () => {
    expect(isPoolPriceStructurallyInvalid(valid)).toBe(false);
  });

  it('triggers for sqrtPriceX96 === 0 -- this actually fires, not an empty category', () => {
    expect(isPoolPriceStructurallyInvalid({ ...valid, sqrtPriceX96: 0n })).toBe(true);
  });

  it('triggers for a negative sqrtPriceX96', () => {
    expect(isPoolPriceStructurallyInvalid({ ...valid, sqrtPriceX96: -1n })).toBe(true);
  });

  it('triggers for tickCurrent below MIN_TICK', () => {
    expect(isPoolPriceStructurallyInvalid({ ...valid, tickCurrent: TickMath.MIN_TICK - 1 })).toBe(true);
  });

  it('triggers for tickCurrent above MAX_TICK', () => {
    expect(isPoolPriceStructurallyInvalid({ ...valid, tickCurrent: TickMath.MAX_TICK + 1 })).toBe(true);
  });

  it('does not trigger exactly at MIN_TICK/MAX_TICK (valid boundary values)', () => {
    expect(isPoolPriceStructurallyInvalid({ ...valid, tickCurrent: TickMath.MIN_TICK })).toBe(false);
    expect(isPoolPriceStructurallyInvalid({ ...valid, tickCurrent: TickMath.MAX_TICK })).toBe(false);
  });
});

describe('evaluateSafetyExit combines both conditions', () => {
  it('false when neither condition is met', () => {
    expect(evaluateSafetyExit({ metricsFailureSince: null, now: T0, poolPrice: { sqrtPriceX96: 2n ** 96n, tickCurrent: 0 } })).toBe(false);
  });

  it('true from condition (a) alone, even with a valid poolPrice', () => {
    const since = new Date(T0.getTime() - MAX_METRICS_FAILURE_MS);
    expect(evaluateSafetyExit({ metricsFailureSince: since, now: T0, poolPrice: { sqrtPriceX96: 2n ** 96n, tickCurrent: 0 } })).toBe(true);
  });

  it('true from condition (b) alone, even with no failure streak', () => {
    expect(evaluateSafetyExit({ metricsFailureSince: null, now: T0, poolPrice: { sqrtPriceX96: 0n, tickCurrent: 0 } })).toBe(true);
  });

  it('false when poolPrice is null (a failed read) and the failure streak has not crossed the threshold -- condition (a) is what governs this case, not a null-poolPrice special case', () => {
    expect(evaluateSafetyExit({ metricsFailureSince: T0, now: T0, poolPrice: null })).toBe(false);
  });
});

describe('isSwapRetryStuck', () => {
  it('false below the threshold', () => {
    expect(isSwapRetryStuck(config.rules.exits.SWAP_RETRY.STUCK_THRESHOLD - 1)).toBe(false);
  });

  it('true at exactly the threshold', () => {
    expect(isSwapRetryStuck(config.rules.exits.SWAP_RETRY.STUCK_THRESHOLD)).toBe(true);
  });

  it('accepts an explicit threshold override', () => {
    expect(isSwapRetryStuck(3, 3)).toBe(true);
    expect(isSwapRetryStuck(2, 3)).toBe(false);
  });
});

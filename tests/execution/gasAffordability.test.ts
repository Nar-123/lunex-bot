import { describe, expect, it } from 'vitest';
import { checkGasAffordability } from '../../src/execution/gasAffordability';

describe('checkGasAffordability', () => {
  it('passes when balance comfortably covers the estimated cost (reserve is OFF by default)', () => {
    const result = checkGasAffordability(100_000n, 1_000_000_000n, 10n ** 18n); // 1 ETH balance vs 0.0001 ETH cost
    expect(result.ok).toBe(true);
  });

  it('rejects when balance is below the estimated gas cost', () => {
    const gasLimit = 100_000n;
    const gasPrice = 1_000_000_000n;
    const cost = gasLimit * gasPrice;
    const result = checkGasAffordability(gasLimit, gasPrice, cost - 1n);
    expect(result.ok).toBe(false);
  });

  it('passes at exactly the boundary (balance == cost)', () => {
    const gasLimit = 100_000n;
    const gasPrice = 1_000_000_000n;
    const cost = gasLimit * gasPrice;
    const result = checkGasAffordability(gasLimit, gasPrice, cost);
    expect(result.ok).toBe(true);
  });

  it('rejects invalid (non-positive) gas parameters rather than dividing/multiplying blindly', () => {
    expect(checkGasAffordability(0n, 1_000_000_000n, 10n ** 18n).ok).toBe(false);
    expect(checkGasAffordability(100_000n, 0n, 10n ** 18n).ok).toBe(false);
    expect(checkGasAffordability(-1n, 1_000_000_000n, 10n ** 18n).ok).toBe(false);
  });
});

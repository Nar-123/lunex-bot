import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { checkPositionManagerBinding } from '../../src/positions/positionManagerBinding';

describe('checkPositionManagerBinding', () => {
  const poolManager: Address = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

  it('passes silently when PositionManager is bound to the configured PoolManager', () => {
    expect(() => checkPositionManagerBinding(poolManager, poolManager)).not.toThrow();
  });

  it('is checksum/case-insensitive', () => {
    const upperCase = poolManager.toUpperCase().replace('0X', '0x') as Address;
    expect(() => checkPositionManagerBinding(upperCase, poolManager)).not.toThrow();
  });

  it('throws with a clear, actionable message on a mismatch', () => {
    const wrongPoolManager: Address = '0x0000000000000000000000000000000000000001';
    expect(() => checkPositionManagerBinding(wrongPoolManager, poolManager)).toThrow(/UNISWAP_V4_POSITION_MANAGER_ADDRESS/);
  });
});

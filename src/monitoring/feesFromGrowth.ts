const Q128 = 1n << 128n;
const UINT256_MODULUS = 1n << 256n;

/**
 * Uniswap v4's fee-accounting formula: uncollected fees owed to a
 * position = liquidity * (feeGrowthInside - feeGrowthInsideLast) / 2^128,
 * where the subtraction is UINT256 SUBTRACTION WITH WRAPAROUND -- Solidity
 * fee-growth counters are unsigned and deliberately allowed to overflow
 * (they only ever increase, and the difference between two snapshots is
 * still meaningful modulo 2^256 even after wrapping). A naive JS
 * `feeGrowthInsideX128 - feeGrowthInsideLastX128` would go negative
 * whenever a wrap happened since the position's last snapshot, which
 * would silently produce a garbage (negative or wrong-magnitude) fee
 * amount -- this reproduces the same modular arithmetic Solidity does.
 *
 * Per explicit review of the real v4 fee-accounting flow -- not derived
 * or guessed independently.
 */
export function feesFromGrowth(feeGrowthInsideX128: bigint, feeGrowthInsideLastX128: bigint, liquidity: bigint): bigint {
  if (liquidity === 0n) return 0n;
  let delta = feeGrowthInsideX128 - feeGrowthInsideLastX128;
  if (delta < 0n) delta += UINT256_MODULUS; // uint256 wraparound
  return (liquidity * delta) / Q128;
}

import { numberToHex, type Address } from 'viem';
import { getPublicClient } from '../blockchain/viemClient';
import { V4_STATE_VIEW_ABI } from '../blockchain/abis/v4StateView';
import { config } from '../config';
import { feesFromGrowth } from './feesFromGrowth';
import type { LivePositionState, LivePositionStateProvider } from './types';
import type { PositionRecord } from '../positions/types';

/** `bytes32(tokenId)` -- the v4 convention for a position's salt (confirmed, not guessed). Exported for direct unit testing. */
export function tokenIdToSalt(positionTokenId: string): `0x${string}` {
  return numberToHex(BigInt(positionTokenId), { size: 32 });
}

/**
 * Real implementation of `LivePositionStateProvider` -- deliberately left
 * unbuilt in Module 7 pending a confirmed v4 fee-accounting spec (StateView's
 * pool-level reads were already confirmed patterns; PositionManager's
 * per-position fee accounting was not, and guessing it wrong would have
 * silently corrupted PNL/fee numbers rather than failed loudly).
 *
 * Flow (per the confirmed spec):
 *  1. `StateView.getPositionInfo(poolId, owner=PositionManager, tickLower,
 *     tickUpper, salt=bytes32(tokenId))` -> current liquidity + the fee
 *     growth snapshot recorded the last time this position was touched.
 *  2. `StateView.getFeeGrowthInside(poolId, tickLower, tickUpper)` ->
 *     the pool's CURRENT fee growth inside that same range.
 *  3. `feesFromGrowth()` (pure, unit-tested separately, including the
 *     uint256-wraparound case) turns the two snapshots + liquidity into
 *     the actual uncollected fee amounts.
 *
 * `owner` in `getPositionInfo` is the PositionManager contract's own
 * address, never the wallet -- v4 positions are held by the periphery
 * contract on the wallet's behalf and distinguished from each other by
 * `salt`, not by `owner`.
 */
export class PositionManagerLivePositionStateProvider implements LivePositionStateProvider {
  async getLiveState(position: PositionRecord): Promise<LivePositionState> {
    if (!position.positionTokenId) {
      throw new Error(`position ${position.id} has no positionTokenId -- cannot read live on-chain state`);
    }
    const client = getPublicClient();
    const stateView = config.uniswap.v4.stateView as Address;
    const positionManager = config.uniswap.v4.positionManager as Address;
    const salt = tokenIdToSalt(position.positionTokenId);
    const { poolId } = position.pool;

    const [positionInfo, feeGrowthInside] = await Promise.all([
      client.readContract({
        address: stateView,
        abi: V4_STATE_VIEW_ABI,
        functionName: 'getPositionInfo',
        args: [poolId, positionManager, position.tickLower, position.tickUpper, salt],
      }),
      client.readContract({
        address: stateView,
        abi: V4_STATE_VIEW_ABI,
        functionName: 'getFeeGrowthInside',
        args: [poolId, position.tickLower, position.tickUpper],
      }),
    ]);

    const [liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128] = positionInfo;
    const [feeGrowthInside0X128, feeGrowthInside1X128] = feeGrowthInside;

    return {
      liquidity,
      tokensOwed0: feesFromGrowth(feeGrowthInside0X128, feeGrowthInside0LastX128, liquidity),
      tokensOwed1: feesFromGrowth(feeGrowthInside1X128, feeGrowthInside1LastX128, liquidity),
    };
  }
}

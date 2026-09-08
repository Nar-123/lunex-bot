import type { Address } from 'viem';
import { getAddress } from 'viem';
import { getPublicClient } from '../blockchain/viemClient';
import { V4_POSITION_MANAGER_ABI } from '../blockchain/abis/v4PositionManager';
import { config } from '../config';

/**
 * Throws if the configured `PositionManager` contract isn't actually
 * bound to the configured `PoolManager` (via `PositionManager.poolManager()`)
 * -- catches a copy/paste mismatch between `UNISWAP_V4_POSITION_MANAGER_ADDRESS`
 * and `UNISWAP_V4_POOL_MANAGER_ADDRESS` at the first real mint, before it
 * can silently send a mint transaction to the wrong contract. Exact same
 * pattern as `pools/poolStateProvider.ts`'s `checkStateViewBinding` --
 * confirmed `PositionManager` exposes the identical `poolManager()` view
 * function by reading the real, installed `@uniswap/v4-sdk`'s own ABI
 * directly (not assumed by analogy). Extracted as a pure function so the
 * comparison logic is unit-testable without an RPC call.
 */
export function checkPositionManagerBinding(boundPoolManager: Address, expectedPoolManager: Address): void {
  if (getAddress(boundPoolManager) !== getAddress(expectedPoolManager)) {
    throw new Error(
      `Config mismatch: PositionManager contract is bound to PoolManager ${boundPoolManager}, but ` +
        `config.uniswap.v4.poolManager is ${expectedPoolManager}. Check UNISWAP_V4_POSITION_MANAGER_ADDRESS / ` +
        `UNISWAP_V4_POOL_MANAGER_ADDRESS in .env.`,
    );
  }
}

let bindingCheck: Promise<void> | undefined;

/** Runs `checkPositionManagerBinding` against the live contract exactly once per process -- called from `mintTx.ts`'s `buildTransaction`, before the first real mint is ever built. */
export function ensurePositionManagerBinding(): Promise<void> {
  if (!bindingCheck) {
    bindingCheck = (async () => {
      const client = getPublicClient();
      const positionManager = config.uniswap.v4.positionManager as Address;
      const boundPoolManager = await client.readContract({
        address: positionManager,
        abi: V4_POSITION_MANAGER_ABI,
        functionName: 'poolManager',
      });
      checkPositionManagerBinding(boundPoolManager, config.uniswap.v4.poolManager as Address);
    })();
  }
  return bindingCheck;
}

/** Test-only: forces the next `ensurePositionManagerBinding()` call to re-run instead of returning a cached (possibly failed) promise from an earlier test. */
export function resetPositionManagerBindingCache(): void {
  bindingCheck = undefined;
}

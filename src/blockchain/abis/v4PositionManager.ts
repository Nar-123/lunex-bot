/**
 * ABI fragment for Uniswap v4's periphery `PositionManager` contract --
 * just the one view function needed for `positions/mintTx.ts`'s
 * self-check (mirrors `pools/poolStateProvider.ts`'s `StateView` binding
 * check exactly). Confirmed present on the real, installed
 * `@uniswap/v4-sdk` package's own `positionManagerAbi` (checked directly,
 * not assumed): `poolManager()` returns the single `PoolManager` this
 * PositionManager instance is bound to, the same self-check contract
 * `StateView` exposes.
 *
 * Actual mint calldata encoding never uses this file -- that goes through
 * `@uniswap/v4-sdk`'s own `V4PositionManager.addCallParameters`
 * (`blockchain/uniswapSdk.ts`), which carries its own complete ABI
 * internally. This fragment exists solely for the lightweight
 * `readContract` binding check, via viem (not the SDK's ethers-based
 * `Interface`), matching how `v4StateView.ts` is used.
 */
export const V4_POSITION_MANAGER_ABI = [
  {
    type: 'function',
    name: 'poolManager',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

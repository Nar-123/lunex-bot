/**
 * ABI fragment for Uniswap v4's periphery `StateView` contract — the
 * standard read-only way to inspect a v4 pool's state (the singleton
 * `PoolManager` itself stores state in transient/regular storage slots
 * not meant to be read via a simple public getter, so official tooling
 * reads through this helper contract instead).
 *
 * BEST EFFORT / UNCONFIRMED for Robinhood Chain specifically (the
 * functions from Module 3 -- `poolManager`, `getSlot0`, `getLiquidity`,
 * `getTickInfo`, `getTickBitmap`): this mirrors the widely-used
 * `StateView.sol` interface from Uniswap's v4 periphery, but this
 * project has no way to check it against the actual deployed bytecode
 * here. Verify `config.uniswap.v4.stateView` points at a contract
 * implementing exactly this ABI before relying on it.
 *
 * `getFeeGrowthInside`/`getPositionInfo` (added for `monitoring/`'s
 * `LivePositionStateProvider`) come from an explicit, reviewed spec of
 * the real v4 fee-accounting flow -- not a guess like the rest of this
 * file. Confirmed convention: `getPositionInfo`'s `owner` parameter is
 * the PositionManager PERIPHERY CONTRACT's own address (never the end
 * wallet), and `salt` is `bytes32(tokenId)` -- that's what actually
 * distinguishes one NFT-backed position from another at the same
 * owner/tick-range.
 */
export const V4_STATE_VIEW_ABI = [
  {
    type: 'function',
    name: 'poolManager',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getSlot0',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' },
    ],
  },
  {
    type: 'function',
    name: 'getLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'liquidity', type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'getTickInfo',
    stateMutability: 'view',
    inputs: [
      { name: 'poolId', type: 'bytes32' },
      { name: 'tick', type: 'int24' },
    ],
    outputs: [
      { name: 'liquidityGross', type: 'uint128' },
      { name: 'liquidityNet', type: 'int128' },
      { name: 'feeGrowthOutside0X128', type: 'uint256' },
      { name: 'feeGrowthOutside1X128', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getTickBitmap',
    stateMutability: 'view',
    inputs: [
      { name: 'poolId', type: 'bytes32' },
      { name: 'tick', type: 'int16' },
    ],
    outputs: [{ name: 'tickBitmap', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getFeeGrowthInside',
    stateMutability: 'view',
    inputs: [
      { name: 'poolId', type: 'bytes32' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
    ],
    outputs: [
      { name: 'feeGrowthInside0X128', type: 'uint256' },
      { name: 'feeGrowthInside1X128', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getPositionInfo',
    stateMutability: 'view',
    inputs: [
      { name: 'poolId', type: 'bytes32' },
      // The v4 convention: individual positions are keyed by
      // (owner, tickLower, tickUpper, salt) where `owner` is the
      // PERIPHERY CONTRACT holding the position on the caller's behalf
      // (PositionManager), not the end-user wallet -- and `salt` is what
      // actually distinguishes one NFT-backed position from another at
      // the same owner/range, set to `bytes32(tokenId)`.
      { name: 'owner', type: 'address' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
    ],
  },
] as const;

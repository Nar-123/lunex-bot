/**
 * Minimal ABI fragments for Uniswap v4's singleton PoolManager — only the
 * two events `pools/` needs (pool discovery via `Initialize`, 6H volume
 * estimation via `Swap`). This is the well-known, stable v4-core event
 * shape; still worth a final check against the actual deployed contract
 * on Robinhood Chain before relying on it with real funds, since this
 * project has no way to inspect that deployment directly.
 */
export const V4_POOL_MANAGER_EVENTS_ABI = [
  {
    type: 'event',
    name: 'Initialize',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'id', type: 'bytes32' },
      { indexed: true, name: 'currency0', type: 'address' },
      { indexed: true, name: 'currency1', type: 'address' },
      { indexed: false, name: 'fee', type: 'uint24' },
      { indexed: false, name: 'tickSpacing', type: 'int24' },
      { indexed: false, name: 'hooks', type: 'address' },
      { indexed: false, name: 'sqrtPriceX96', type: 'uint160' },
      { indexed: false, name: 'tick', type: 'int24' },
    ],
  },
  {
    type: 'event',
    name: 'Swap',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'id', type: 'bytes32' },
      { indexed: true, name: 'sender', type: 'address' },
      { indexed: false, name: 'amount0', type: 'int128' },
      { indexed: false, name: 'amount1', type: 'int128' },
      { indexed: false, name: 'sqrtPriceX96', type: 'uint160' },
      { indexed: false, name: 'liquidity', type: 'uint128' },
      { indexed: false, name: 'tick', type: 'int24' },
      { indexed: false, name: 'fee', type: 'uint24' },
    ],
  },
] as const;

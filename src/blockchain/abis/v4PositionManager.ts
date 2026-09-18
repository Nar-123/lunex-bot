/**
 * ABI fragment for Uniswap v4's periphery `PositionManager` contract --
 * just the view functions needed for `positions/mintTx.ts`'s self-check and
 * (P1-9) on-chain position-identity verification. Both entries are
 * transcribed EXACTLY (fields renamed to nothing, types unchanged) from the
 * real, installed `@uniswap/v4-sdk` package's own `positionManagerAbi`
 * (`node_modules/@uniswap/v4-sdk/dist/cjs/src/utils/positionManagerAbi.js`)
 * -- checked directly against that file, never hand-typed from memory:
 *   - `poolManager()` returns the single `PoolManager` this PositionManager
 *     instance is bound to, the same self-check contract `StateView`
 *     exposes.
 *   - `getPoolAndPositionInfo(tokenId)` returns the position's immutable
 *     `PoolKey` (currency0/currency1/fee/tickSpacing/hooks) as a normal
 *     ABI-decoded tuple, plus a packed `PositionInfo` uint256 (`info`).
 *     ONLY the `poolKey` half is used here (`mintTx.ts`'s `verifyOnChain`,
 *     P1-9) -- `info` packs tickLower/tickUpper/hasSubscriber per Uniswap
 *     v4's `PositionInfoLibrary` bit layout, which is NOT decoded anywhere
 *     in this codebase: the exact bit layout could not be confirmed against
 *     an authoritative source in this environment (the installed npm
 *     package ships only the ABI/bytecode, not the `PositionInfoLibrary.sol`
 *     source, and there is no network access here to fetch it), and
 *     guessing a bit-packing wrong would silently produce a WRONG
 *     tickLower/tickUpper comparison -- worse than not checking at all, per
 *     this project's "never guess, verify against real evidence" rule. The
 *     `poolKey` fields (a plain ABI tuple, not packed) carry no such risk
 *     and are cross-checked; tickLower/tickUpper identity is verified
 *     another way instead -- see `mintTx.ts`'s doc comment on
 *     `verifyOnChain` for how.
 */
export const V4_POSITION_MANAGER_ABI = [
  {
    type: 'function',
    name: 'poolManager',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getPoolAndPositionInfo',
    inputs: [{ name: 'tokenId', type: 'uint256', internalType: 'uint256' }],
    outputs: [
      {
        name: 'poolKey',
        type: 'tuple',
        internalType: 'struct PoolKey',
        components: [
          { name: 'currency0', type: 'address', internalType: 'Currency' },
          { name: 'currency1', type: 'address', internalType: 'Currency' },
          { name: 'fee', type: 'uint24', internalType: 'uint24' },
          { name: 'tickSpacing', type: 'int24', internalType: 'int24' },
          { name: 'hooks', type: 'address', internalType: 'contract IHooks' },
        ],
      },
      { name: 'info', type: 'uint256', internalType: 'PositionInfo' },
    ],
    stateMutability: 'view',
  },
] as const;

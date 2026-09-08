import type { Address } from 'viem';
import { encodeFunctionData } from 'viem';
import { getPublicClient } from './viemClient';

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

/**
 * Generic ERC20 `balanceOf` read for an arbitrary token -- factored out of
 * `capital/usdgBalanceReader.ts` (which stays USDG-specific by name/intent)
 * because `exits/swapTx.ts` needs the SAME read for two different tokens:
 * the TOKEN being exited (to determine how much to swap, after
 * remove-liquidity) and USDG again (to verify the swap's on-chain effect).
 */
export async function readErc20Balance(tokenAddress: Address, walletAddress: Address): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [walletAddress],
  });
}

/** Generic ERC20 `allowance` read -- `exits/approveTx.ts` uses this to check whether an `approve()` transaction is even necessary before the exit swap runs. */
export async function readErc20Allowance(tokenAddress: Address, owner: Address, spender: Address): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  });
}

/**
 * Generic ERC20 `decimals` read -- no existing utility reads this anywhere
 * in the codebase (`discovery/`'s `CandidateToken` doesn't carry it, GMGN's
 * responses don't include it). `positions/openPosition.ts` needs a
 * candidate token's real decimals to construct its `Token` entity for the
 * v4 SDK's liquidity math -- assuming 18 (like USDG) would silently
 * mis-price any token that isn't.
 */
export async function readErc20Decimals(tokenAddress: Address): Promise<number> {
  const client = getPublicClient();
  return client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'decimals',
    args: [],
  });
}

/** Encodes calldata for an ERC20 `approve(spender, amount)` call -- `to` is the TOKEN contract itself (not the spender), matching ERC20's own call shape. */
export function encodeErc20Approve(tokenAddress: Address, spender: Address, amount: bigint): { to: Address; data: `0x${string}` } {
  return {
    to: tokenAddress,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }),
  };
}

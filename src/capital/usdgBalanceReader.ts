import type { Address } from 'viem';
import { getPublicClient } from '../blockchain/viemClient';
import { config } from '../config';

const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/**
 * Reads the executor wallet's current USDG token balance on-chain. Since
 * the LP strategy is USDG-only at entry and positions are opened via
 * `PositionManager.modifyLiquidities()` (a real ERC20 transfer out of the
 * wallet, not an allowance/escrow that leaves the balance untouched),
 * deployed USDG has already left this balance by the time a position is
 * active -- so this figure directly IS "free/available USDG," no
 * separate subtraction of already-deployed amounts is needed.
 */
export async function readUsdgBalance(walletAddress: Address): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({
    address: config.quoteAsset.ADDRESS as Address,
    abi: ERC20_BALANCE_OF_ABI,
    functionName: 'balanceOf',
    args: [walletAddress],
  });
}

import type { Address } from 'viem';
import { getPublicClient } from './viemClient';

/**
 * Read-only Permit2 (AllowanceTransfer) and PositionManager reads.
 *
 * Permit2 semantics relied on (Uniswap Permit2 `AllowanceTransfer`):
 *  - `allowance(owner, token, spender)` -> (uint160 amount, uint48 expiration, uint48 nonce);
 *  - `transferFrom` reverts `AllowanceExpired` iff `block.timestamp > expiration`
 *    (a grant is still usable AT its expiration second);
 *  - reverts `InsufficientAllowance` iff amount < requested; an amount of
 *    `type(uint160).max` is never decremented;
 *  - the token itself must ALSO have an ordinary ERC20 allowance
 *    `allowance(owner, Permit2)` -- that is what Permit2's `transferFrom` spends.
 */
export const PERMIT2_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
] as const;

export const POSITION_MANAGER_PERMIT2_ABI = [
  { type: 'function', name: 'permit2', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

export interface Permit2Grant {
  amount: bigint;
  /** unix seconds */
  expiration: number;
  nonce: number;
}

export async function readPermit2Grant(permit2: Address, owner: Address, token: Address, spender: Address): Promise<Permit2Grant> {
  const [amount, expiration, nonce] = await getPublicClient().readContract({ address: permit2, abi: PERMIT2_ABI, functionName: 'allowance', args: [owner, token, spender] });
  return { amount, expiration, nonce }; // uint48 -> number (viem)
}

/** The Permit2 address the PositionManager is actually bound to (immutable in the contract). */
export async function readPositionManagerPermit2(positionManager: Address): Promise<Address> {
  return getPublicClient().readContract({ address: positionManager, abi: POSITION_MANAGER_PERMIT2_ABI, functionName: 'permit2' });
}

/** Latest block timestamp (unix seconds) -- the clock Permit2's expiry check actually uses. */
export async function readChainTimestamp(): Promise<number> {
  const block = await getPublicClient().getBlock({ blockTag: 'latest' });
  return Number(block.timestamp);
}

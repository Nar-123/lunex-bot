import type { Address } from 'viem';
import { parseEventLogs, zeroAddress } from 'viem';
import { getPublicClient } from './viemClient';

const ERC721_TRANSFER_EVENT = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
  ],
} as const;

const ERC721_OWNER_OF_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
] as const;

/** Exported so `reconciliation/` can build its own Transfer-log scans against an arbitrary ERC721 contract (the v4 PositionManager) without duplicating the event ABI. */
export { ERC721_TRANSFER_EVENT };

/**
 * H5 (reconciliation): reads an ERC721 token's current owner, distinguishing
 * a genuine "this token does not exist / has been burned" fact (a real
 * ERC721 revert -- standard `ownerOf` behavior for a nonexistent tokenId)
 * from a transient RPC/network failure. Returns `null` ONLY for the
 * former; the latter is rethrown so callers never mistake "couldn't check"
 * for "confirmed gone."
 */
export async function ownerOfNft(contractAddress: Address, tokenId: bigint): Promise<Address | null> {
  const client = getPublicClient();
  try {
    return await client.readContract({ address: contractAddress, abi: ERC721_OWNER_OF_ABI, functionName: 'ownerOf', args: [tokenId] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // viem wraps a contract revert in ContractFunctionExecutionError/
    // ContractFunctionRevertedError -- "revert"/"nonexistent token" is the
    // reliable substring signal, same conservative philosophy as
    // execution/viemTxSteps.ts's isDefinitiveSimulationRevert (H2).
    if (message.toLowerCase().includes('revert')) {
      return null;
    }
    throw err;
  }
}

export class MintedTokenIdNotFoundError extends Error {
  constructor(txHash: `0x${string}`, contractAddress: Address, recipient: Address) {
    super(`No ERC721 Transfer(from=0x0, to=${recipient}) event found in receipt logs for tx ${txHash} at contract ${contractAddress}`);
    this.name = 'MintedTokenIdNotFoundError';
  }
}

/**
 * Discovers a newly-minted NFT's tokenId from its mint transaction's own
 * receipt -- the ONLY way to learn it, since the v4 PositionManager
 * assigns tokenIds itself (a counter shared across every user of the
 * contract, not just us) and has no "give me my last mint" view function.
 * Reading a counter before minting and assuming our mint used exactly
 * that value would be a real race condition on a permissionless, shared
 * contract -- this reads the actual `Transfer(from=0x0, to=recipient,
 * tokenId)` event the mint itself emitted instead.
 *
 * Used by `positions/mintTx.ts`'s `verifyOnChain` (the confirmed
 * transaction's hash is passed in by `execution/executeCriticalTransaction.ts`
 * specifically to make this possible -- see `execution/types.ts`'s
 * `TxSafetyDeps.verifyOnChain` doc comment for why that parameter exists).
 */
export async function discoverMintedTokenId(
  txHash: `0x${string}`,
  contractAddress: Address,
  recipient: Address,
): Promise<bigint> {
  const client = getPublicClient();
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const events = parseEventLogs({
    abi: [ERC721_TRANSFER_EVENT],
    logs: receipt.logs,
    eventName: 'Transfer',
  });

  const mintEvent = events.find(
    (event) =>
      event.address.toLowerCase() === contractAddress.toLowerCase() &&
      event.args.from.toLowerCase() === zeroAddress &&
      event.args.to.toLowerCase() === recipient.toLowerCase(),
  );

  if (!mintEvent) {
    throw new MintedTokenIdNotFoundError(txHash, contractAddress, recipient);
  }
  return mintEvent.args.tokenId;
}

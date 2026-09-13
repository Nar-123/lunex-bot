import type { Address, Log } from 'viem';
import { decodeEventLog, getAddress, zeroAddress } from 'viem';
import { getPublicClient } from '../blockchain/viemClient';
import { ERC721_TRANSFER_EVENT, ownerOfNft } from '../blockchain/erc721';
import { config } from '../config';
import type { NftOwnerChecker, OwnedNftLister, OwnerCheckResult } from './types';

/** Same rationale/limits as `pools/poolDiscovery.ts`'s identical constant -- most public RPC providers cap the block range of a single `eth_getLogs` call. */
const LOG_SCAN_CHUNK_BLOCKS = 5_000n;

/**
 * H5: real `OwnedNftLister` -- the v4 PositionManager has no
 * ERC721Enumerable extension (confirmed: standard Uniswap position
 * managers don't implement it), so enumerating every NFT a wallet
 * currently owns requires scanning its own `Transfer` event history and
 * computing net ownership (received minus sent), the same log-scanning
 * approach `pools/poolDiscovery.ts` already uses for pool discovery.
 * Throws on any RPC failure -- callers must never treat a thrown error as
 * "wallet owns nothing."
 */
export class PositionManagerLogNftLister implements OwnedNftLister {
  async listOwnedTokenIds(wallet: Address): Promise<string[]> {
    const client = getPublicClient();
    const positionManager = config.uniswap.v4.positionManager as Address;
    const fromBlock = config.uniswap.v4.positionManagerDeployBlock;
    const latestBlock = await client.getBlockNumber();
    const normalizedWallet = getAddress(wallet);

    const owned = new Set<string>();
    for (let start = fromBlock; start <= latestBlock; start += LOG_SCAN_CHUNK_BLOCKS) {
      const end = start + LOG_SCAN_CHUNK_BLOCKS - 1n > latestBlock ? latestBlock : start + LOG_SCAN_CHUNK_BLOCKS - 1n;

      const [received, sent] = await Promise.all([
        client.getLogs({ address: positionManager, event: ERC721_TRANSFER_EVENT, args: { to: normalizedWallet }, fromBlock: start, toBlock: end }),
        client.getLogs({ address: positionManager, event: ERC721_TRANSFER_EVENT, args: { from: normalizedWallet }, fromBlock: start, toBlock: end }),
      ]);

      // Merge and replay in block/log order so a mint-then-transfer-away
      // within the SAME chunk nets out correctly (a naive "add all
      // received, remove all sent" independent of order still nets out
      // the same for a simple owned/not-owned set, but sorting keeps this
      // correct and obviously so if this is ever extended to track more
      // than membership).
      type TransferLogEvent = { l: Log; kind: 'in' | 'out' };
      const events: TransferLogEvent[] = [
        ...received.map((l): TransferLogEvent => ({ l, kind: 'in' })),
        ...sent.map((l): TransferLogEvent => ({ l, kind: 'out' })),
      ].sort((a, b) => {
        const blockDiff = (a.l.blockNumber ?? 0n) - (b.l.blockNumber ?? 0n);
        if (blockDiff !== 0n) return blockDiff < 0n ? -1 : 1;
        return (a.l.logIndex ?? 0) - (b.l.logIndex ?? 0);
      });
      for (const { l, kind } of events) {
        const tokenId = decodeTransferTokenId(l);
        if (tokenId === undefined) continue;
        if (kind === 'in') owned.add(tokenId);
        else owned.delete(tokenId);
      }
    }
    return [...owned];
  }
}

function decodeTransferTokenId(log: Log): string | undefined {
  try {
    // `eventName: 'Transfer'` in the call narrows viem's return to the
    // Transfer variant already -- no runtime re-check is reachable.
    const decoded = decodeEventLog({ abi: [ERC721_TRANSFER_EVENT], ...log });
    return decoded.args.tokenId.toString();
  } catch {
    return undefined;
  }
}

/**
 * H5: real `NftOwnerChecker` -- wraps `blockchain/erc721.ts`'s `ownerOfNft`
 * (which already distinguishes a confirmed ERC721 revert from a transport
 * failure) into this module's `OwnerCheckResult` shape.
 */
export class PositionManagerNftOwnerChecker implements NftOwnerChecker {
  async checkOwner(tokenId: string): Promise<OwnerCheckResult> {
    const positionManager = config.uniswap.v4.positionManager as Address;
    try {
      const owner = await ownerOfNft(positionManager, BigInt(tokenId));
      if (owner === null || owner === zeroAddress) return { status: 'NOT_FOUND_CONFIRMED' };
      return { status: 'FOUND', owner };
    } catch {
      return { status: 'RPC_UNAVAILABLE' };
    }
  }
}

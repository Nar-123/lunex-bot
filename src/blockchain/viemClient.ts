import { createPublicClient, http, type PublicClient } from 'viem';
import { config } from '../config';
import { robinhoodChain } from './viemChain';

let cachedClient: PublicClient | undefined;

/**
 * Read-only viem client (RPC calls: logs, contract reads/simulations).
 * Used by `pools/` for pool discovery and state/quote reads. The
 * signing/transaction-sending client (nonce management, the full
 * transaction-safety flow) is built in Module 5 (`execution/`) — this is
 * intentionally read-only.
 */
export function getPublicClient(): PublicClient {
  if (!cachedClient) {
    cachedClient = createPublicClient({
      chain: robinhoodChain,
      transport: http(config.chain.rpcUrl),
    });
  }
  return cachedClient;
}

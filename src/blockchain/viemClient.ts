import { createPublicClient, type PublicClient } from 'viem';
import { config } from '../config';
import { robinhoodChain } from './viemChain';
import { buildRpcTransport, resolveRpcEndpoints } from './rpcTransport';

let cachedClient: PublicClient | undefined;

/**
 * Read-only viem client (RPC calls: logs, contract reads/simulations).
 * Used by `pools/` for pool discovery and state/quote reads. The
 * signing/transaction-sending client (nonce management, the full
 * transaction-safety flow) is built in Module 5 (`execution/`) — this is
 * intentionally read-only.
 *
 * Its transport is the ORDERED FAILOVER transport (`rpcTransport.ts`): the
 * configured primary first, then each configured fallback, moving on only for
 * provider-level failures (429/5xx/timeout/socket) and never for a deterministic
 * answer such as a reverting `eth_call`. Every chain read, broadcast and receipt
 * wait in this project goes through THIS client (`execution/viemTxSteps.ts`), so
 * endpoint policy lives in exactly one place.
 */
export function getPublicClient(): PublicClient {
  if (!cachedClient) {
    const { urls, dropped } = resolveRpcEndpoints(config.chain.rpcUrl, config.chain.rpcFallbackUrls);
    if (dropped.length > 0) {
      // Indexes and reasons only -- an RPC URL can embed an API key.
      console.warn('rpc_fallback_entries_skipped', { count: dropped.length, entries: dropped });
    }
    cachedClient = createPublicClient({
      chain: robinhoodChain,
      transport: buildRpcTransport(urls),
    });
  }
  return cachedClient;
}

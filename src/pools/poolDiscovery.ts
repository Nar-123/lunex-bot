import type { Address, Log } from 'viem';
import { decodeEventLog, getAddress } from 'viem';
import { getPublicClient } from '../blockchain/viemClient';
import { config } from '../config';
import { V4_POOL_MANAGER_EVENTS_ABI } from '../blockchain/abis/v4PoolManager';
import type { PoolDiscoveryPort, V4PoolKey, V4PoolRef } from './types';

/**
 * Blocks per `eth_getLogs` call. Most public RPC providers cap the block
 * range of a single log query (commonly a few thousand blocks); this
 * chunks a full scan from the PoolManager's deploy block to `latest` so a
 * long-lived chain doesn't just fail outright on one oversized request.
 * BEST EFFORT: tune based on Robinhood Chain's actual RPC provider limits.
 */
const LOG_SCAN_CHUNK_BLOCKS = 5_000n;

function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

/**
 * Enumerates every v4 pool ever initialized for a currency pair by
 * scanning `PoolManager.Initialize` event logs, filtered on the
 * (sorted) `currency0`/`currency1` indexed topics.
 *
 * BEST EFFORT / flagged for verification: v4 has no on-chain "list pools
 * for a pair" function (unlike v3's factory `getPool` per fixed fee
 * tier) — log scanning against the real event history is the standard
 * way third-party integrations do this without a subgraph/indexer.
 * Isolated behind `PoolDiscoveryPort` so a future indexer-backed
 * implementation is a drop-in replacement.
 */
export class PoolManagerLogDiscovery implements PoolDiscoveryPort {
  async findPoolsForPair(currencyA: Address, currencyB: Address): Promise<V4PoolRef[]> {
    const [currency0, currency1] = sortCurrencies(getAddress(currencyA), getAddress(currencyB));
    const client = getPublicClient();
    const poolManager = config.uniswap.v4.poolManager as Address;
    const fromBlock = config.uniswap.v4.poolManagerDeployBlock;
    const latestBlock = await client.getBlockNumber();

    const pools: V4PoolRef[] = [];
    for (let start = fromBlock; start <= latestBlock; start += LOG_SCAN_CHUNK_BLOCKS) {
      const end = start + LOG_SCAN_CHUNK_BLOCKS - 1n > latestBlock ? latestBlock : start + LOG_SCAN_CHUNK_BLOCKS - 1n;
      const logs = await client.getLogs({
        address: poolManager,
        event: V4_POOL_MANAGER_EVENTS_ABI[0],
        args: { currency0, currency1 },
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs) {
        const decoded = decodeInitializeLog(log);
        if (decoded) pools.push(decoded);
      }
    }
    return pools;
  }
}

function decodeInitializeLog(log: Log): V4PoolRef | undefined {
  try {
    const decoded = decodeEventLog({ abi: V4_POOL_MANAGER_EVENTS_ABI, ...log });
    if (decoded.eventName !== 'Initialize') return undefined;
    const { id, currency0, currency1, fee, tickSpacing, hooks } = decoded.args;
    const key: V4PoolKey = { currency0, currency1, fee, tickSpacing, hooks };
    return { poolId: id, key };
  } catch {
    return undefined;
  }
}

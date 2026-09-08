import type { Address } from 'viem';
import { getPublicClient } from '../blockchain/viemClient';
import { config } from '../config';
import { V4_POOL_MANAGER_EVENTS_ABI } from '../blockchain/abis/v4PoolManager';
import type { PoolVolumeProviderPort, V4PoolRef } from './types';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const LOG_SCAN_CHUNK_BLOCKS = 5_000n;

/**
 * Converts a raw bigint token amount to a JS `number`, without risking
 * silent precision loss from a huge bigint exceeding
 * `Number.MAX_SAFE_INTEGER` (very real here: an 18-decimal USDG amount
 * worth just ~$1M is already ~10^24 raw units). Keeps 6 decimal digits
 * of precision via integer bigint division before converting to `number`.
 */
function rawToNumber(raw: bigint, decimals: number): number {
  const PRECISION_DIGITS = 6;
  if (decimals <= PRECISION_DIGITS) {
    return Number(raw) / 10 ** decimals;
  }
  const scaled = raw / 10n ** BigInt(decimals - PRECISION_DIGITS);
  return Number(scaled) / 10 ** PRECISION_DIGITS;
}

/**
 * Estimates a v4 pool's average block time by sampling two blocks far
 * apart, so a 6H window can be converted into an approximate block range
 * for `eth_getLogs`. BEST EFFORT: a per-chain constant read from
 * observed block times would be more efficient/accurate; this keeps the
 * provider self-contained without another config value to keep in sync.
 */
async function estimateBlocksFor(ms: number): Promise<bigint> {
  const client = getPublicClient();
  const latest = await client.getBlock({ blockTag: 'latest' });
  const sampleBack = 10_000n;
  const pastBlockNumber = latest.number > sampleBack ? latest.number - sampleBack : 0n;
  const past = await client.getBlock({ blockNumber: pastBlockNumber });
  const blockSpan = latest.number - past.number;
  const timeSpanMs = Number(latest.timestamp - past.timestamp) * 1000;
  if (timeSpanMs <= 0 || blockSpan <= 0n) return 0n;
  const avgBlockTimeMs = timeSpanMs / Number(blockSpan);
  return BigInt(Math.ceil(ms / avgBlockTimeMs));
}

/**
 * Sums a pool's real swap volume (in USDG, since every pool this bot
 * touches is TOKEN/USDG) over the last 6 hours by aggregating
 * `PoolManager.Swap` event logs for that specific `poolId`.
 *
 * BEST EFFORT / flagged for verification: v4 has no built-in "24h/6h
 * volume" counter — computing it from raw Swap logs is the standard
 * approach without a subgraph/indexer, but it means one
 * `estimateBlocksFor` call plus a chunked `eth_getLogs` scan every time a
 * pool's volume is needed. For a chain with heavy swap activity or a
 * rate-limited RPC, replacing this with a real indexer/subgraph-backed
 * `PoolVolumeProviderPort` implementation (same interface, no changes
 * needed in `selectPool.ts`) is the recommended production path.
 */
export class SwapLogPoolVolumeProvider implements PoolVolumeProviderPort {
  async get6hVolumeUsd(pool: V4PoolRef): Promise<number> {
    const client = getPublicClient();
    const poolManager = config.uniswap.v4.poolManager as Address;
    const latestBlock = await client.getBlockNumber();
    const blocksIn6h = await estimateBlocksFor(SIX_HOURS_MS);
    const deployBlock = config.uniswap.v4.poolManagerDeployBlock;
    const fromBlock = blocksIn6h > latestBlock - deployBlock ? deployBlock : latestBlock - blocksIn6h;

    const usdgIsCurrency0 = pool.key.currency0.toLowerCase() === config.quoteAsset.ADDRESS.toLowerCase();
    const usdgDecimals = config.quoteAsset.DECIMALS;

    let totalUsdgRaw = 0n;
    for (let start = fromBlock; start <= latestBlock; start += LOG_SCAN_CHUNK_BLOCKS) {
      const end = start + LOG_SCAN_CHUNK_BLOCKS - 1n > latestBlock ? latestBlock : start + LOG_SCAN_CHUNK_BLOCKS - 1n;
      const logs = await client.getLogs({
        address: poolManager,
        event: V4_POOL_MANAGER_EVENTS_ABI[1],
        args: { id: pool.poolId },
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs) {
        const { amount0, amount1 } = log.args;
        if (amount0 === undefined || amount1 === undefined) continue;
        const usdgAmount = usdgIsCurrency0 ? amount0 : amount1;
        totalUsdgRaw += usdgAmount < 0n ? -usdgAmount : usdgAmount;
      }
    }

    return rawToNumber(totalUsdgRaw, usdgDecimals);
  }
}

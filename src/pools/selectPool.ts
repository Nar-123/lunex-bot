import type { Token } from '@uniswap/sdk-core';
import { config } from '../config';
import { estimateExitPriceImpact } from './priceImpact';
import type { PoolEvaluation, PoolSelectionDeps, PoolSelectionResult } from './types';

/**
 * Pool selection, per the (v4-only) architecture that replaces the old
 * fee-tier-by-volume design entirely:
 *
 *   discover every TOKEN/USDG v4 pool
 *   -> keep only pools with fee > 0 AND estimated exit price impact
 *      <= PRICE_IMPACT.MAX_EXIT_IMPACT_PCT (real simulation, see
 *      priceImpact.ts — never a TVL ratio)
 *   -> among survivors, pick the highest 6H volume
 *   -> no pools at all, or none survive the filters -> reject the
 *      candidate entirely (caller falls through to the next GMGN
 *      candidate, per the existing per-cycle fallback rule)
 *
 * `positionSizeUsdgRaw` MUST be the real position size the caller is
 * about to deploy (35% of free USDG, computed by `capital/` at the
 * moment this candidate is evaluated) — not a fixed test figure. Passing
 * a stale or fixed value defeats the point of simulating against the
 * pool's real liquidity relative to what will actually be deployed.
 */
export async function selectPool(
  token: Token,
  usdg: Token,
  positionSizeUsdgRaw: bigint,
  deps: PoolSelectionDeps,
): Promise<PoolSelectionResult> {
  const pools = await deps.discovery.findPoolsForPair(token.address as `0x${string}`, usdg.address as `0x${string}`);

  if (pools.length === 0) {
    return { selected: false, reason: 'NO_POOLS_FOUND', evaluations: [] };
  }

  const evaluations: PoolEvaluation[] = [];
  for (const pool of pools) {
    if (pool.key.fee <= config.rules.poolSelection.MIN_FEE) {
      evaluations.push({ pool, volume6hUsd: 0, passed: false, rejectReason: 'fee is 0' });
      continue;
    }

    const state = await deps.state.getState(pool);
    const priceImpact = await estimateExitPriceImpact(pool.key, state, token, usdg, positionSizeUsdgRaw);
    const impactOk = priceImpact.ok && priceImpact.passesThreshold;

    if (!impactOk) {
      evaluations.push({
        pool,
        volume6hUsd: 0,
        priceImpact,
        passed: false,
        rejectReason: priceImpact.ok
          ? `exit price impact ${(priceImpact.priceImpactPct * 100).toFixed(3)}% exceeds ${(config.rules.priceImpact.MAX_EXIT_IMPACT_PCT * 100).toFixed(2)}%`
          : `price impact could not be verified: ${priceImpact.reason}`,
      });
      continue;
    }

    const volume6hUsd = await deps.volume.get6hVolumeUsd(pool);
    evaluations.push({ pool, volume6hUsd, priceImpact, passed: true });
  }

  const survivors = evaluations.filter((e) => e.passed);
  if (survivors.length === 0) {
    return { selected: false, reason: 'ALL_POOLS_REJECTED', evaluations };
  }

  const best = survivors.reduce((a, b) => (b.volume6hUsd > a.volume6hUsd ? b : a));
  return {
    selected: true,
    pool: best.pool,
    volume6hUsd: best.volume6hUsd,
    priceImpactPct: best.priceImpact?.ok ? best.priceImpact.priceImpactPct : 0,
    evaluations,
  };
}

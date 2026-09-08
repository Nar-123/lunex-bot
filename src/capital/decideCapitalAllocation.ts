import type { CapitalAllocationResult, CapitalRules, CapitalSnapshot } from './types';

/** Decimal digits of precision kept when converting a config decimal (e.g. 0.35) into bigint math. */
const FRACTION_PRECISION = 1_000_000;

/** `amount * fraction`, exact-enough bigint math for a plain JS decimal (e.g. 0.35, or 0.05 for "0.05 ETH"). */
function scaleByFraction(amount: bigint, fraction: number): bigint {
  const scaled = BigInt(Math.round(fraction * FRACTION_PRECISION));
  return (amount * scaled) / BigInt(FRACTION_PRECISION);
}

/**
 * Extracted as its own pure function (parameters explicit, not read from
 * `config`) so both states of this deliberately-toggleable, currently-OFF
 * feature can be unit-tested directly -- `config.rules.capital`'s live
 * value can't easily be flipped per-test since `config` is a
 * frozen-at-import singleton like everywhere else in this project.
 */
export function checkEthGasReserve(
  ethBalance: bigint | undefined,
  enabled: boolean,
  reserveMinEth: number,
): { ok: true } | { ok: false; reason: string } {
  if (!enabled) return { ok: true };
  if (ethBalance === undefined) {
    return { ok: false, reason: 'ETH gas reserve check is enabled but no ETH balance was provided in the snapshot' };
  }
  // reserveMinEth is expressed in whole ETH (human units) -- converted to
  // wei (18 decimals) for comparison against the raw wei balance. Exact
  // semantics are explicitly unlocked/TBD per spec; revisit this
  // conversion when the feature is actually turned on.
  const reserveMinWei = scaleByFraction(1_000_000_000_000_000_000n, reserveMinEth);
  if (ethBalance < reserveMinWei) {
    return {
      ok: false,
      reason: `ETH balance (${ethBalance} wei) is below the configured gas reserve (${reserveMinWei} wei)`,
    };
  }
  return { ok: true };
}

/**
 * Pure function (no I/O): decides whether a new position may be deployed
 * this cycle and, if so, its size -- per spec section 5 (Capital
 * Management):
 *   - position size = 35% of FREE/available USDG balance, computed from
 *     the snapshot passed in (the caller is responsible for taking that
 *     snapshot "right now," per Module 3's `selectPool` precedent -- this
 *     function never caches or re-fetches anything itself);
 *   - max 3 active positions at once;
 *   - max total deployed = 90% of total portfolio (free + deployed),
 *     a hard cap -- checked against what deploying THIS position would
 *     push total deployed to, not just the current state;
 *   - the ETH gas reserve check is included but only enforced when
 *     `rules.ETH_GAS_RESERVE_ENABLED` is true (default false / explicitly
 *     TBD per spec) -- see `types.ts`.
 *
 * `rules` is an explicit, required parameter (Module 10) rather than read
 * from `config` internally -- `MAX_ACTIVE_POSITIONS`/
 * `POSITION_SIZE_PCT_OF_FREE_BALANCE` are live-editable via `settings/`;
 * the composition root (`screeningCycle.ts`) is responsible for merging
 * the live values over frozen `config.rules.capital` once per cycle and
 * passing the result in here -- this function itself stays pure and
 * config-oblivious, same discipline as `checkEthGasReserve` already used.
 *
 * "1 coin = 1 position" (no duplicate token) is NOT re-checked here --
 * that's `filters/rules/duplicatePosition.ts`'s job during screening
 * (Module 2), a different concern (per-token) from this module's
 * aggregate sizing/exposure decisions.
 */
export function decideCapitalAllocation(snapshot: CapitalSnapshot, rules: CapitalRules): CapitalAllocationResult {
  if (snapshot.activePositionsCount >= rules.MAX_ACTIVE_POSITIONS) {
    return {
      ok: false,
      reason: `max active positions reached (${snapshot.activePositionsCount}/${rules.MAX_ACTIVE_POSITIONS})`,
    };
  }

  const ethReserveCheck = checkEthGasReserve(snapshot.ethBalance, rules.ETH_GAS_RESERVE_ENABLED, rules.ETH_GAS_RESERVE_MIN);
  if (!ethReserveCheck.ok) {
    return ethReserveCheck;
  }

  const positionSizeUsdgRaw = scaleByFraction(snapshot.freeUsdgBalance, rules.POSITION_SIZE_PCT_OF_FREE_BALANCE);
  if (positionSizeUsdgRaw <= 0n) {
    return { ok: false, reason: `computed position size is not positive (free balance: ${snapshot.freeUsdgBalance})` };
  }

  const totalPortfolio = snapshot.freeUsdgBalance + snapshot.totalDeployedUsdg;
  const projectedTotalDeployed = snapshot.totalDeployedUsdg + positionSizeUsdgRaw;
  const maxAllowedDeployed = scaleByFraction(totalPortfolio, rules.MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO);

  if (projectedTotalDeployed > maxAllowedDeployed) {
    return {
      ok: false,
      reason:
        `deploying ${positionSizeUsdgRaw} would bring total deployed to ${projectedTotalDeployed}, ` +
        `exceeding the ${(rules.MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO * 100).toFixed(0)}% cap ` +
        `(${maxAllowedDeployed}) of total portfolio (${totalPortfolio})`,
    };
  }

  return { ok: true, positionSizeUsdgRaw };
}

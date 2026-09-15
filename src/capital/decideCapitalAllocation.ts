import type { CapitalAllocationResult, CapitalRules, CapitalSnapshot } from './types';

/** Decimal digits of precision kept when converting a config decimal (e.g. 0.35) into bigint math. */
const FRACTION_PRECISION = 1_000_000;

/** `amount * fraction`, exact-enough bigint math for a plain JS decimal (e.g. 0.35, or 0.05 for "0.05 ETH"). Exported for `capital/canary.ts`'s cap math -- same bigint-precision discipline, never duplicated. */
export function scaleByFraction(amount: bigint, fraction: number): bigint {
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
 * Management), Phase 10C-REVISION's corrected final policy:
 *   - `basePortfolioBalance = freeUsdgBalance + totalDeployedUsdg` -- the
 *     CANONICAL, already-existing stable portfolio reference (no new
 *     balance source invented). It does NOT shrink merely because a
 *     previous position was deployed this cycle or earlier -- deploying
 *     only MOVES capital between the free and deployed buckets, it never
 *     removes it from this sum (the same algebraic invariant
 *     `capitalSnapshotProvider.ts`'s doc comment already proves for
 *     `totalDeployedUsdg`'s OPENING/CLOSING accounting). It DOES change
 *     over time for real reasons -- a deposit, a withdrawal, or a
 *     position's realized PnL differing from its entry size once closed
 *     -- which is correct: this is the TRUE current portfolio value, not
 *     a frozen "initial balance" snapshot from position #1.
 *   - TARGET size = 35% of `basePortfolioBalance` (Phase 10C-REVISION
 *     correction: NOT 35% of the current/shrinking `freeUsdgBalance` --
 *     that was Phase 10C's bug. `rules.POSITION_SIZE_PCT_OF_FREE_BALANCE`
 *     keeps its historical field name for now, but is applied against the
 *     STABLE base balance here, not literally "free balance" -- see
 *     `types.ts`'s doc comment on that field).
 *   - ACTUAL size = `min(targetSize, remainingCapacity)`, where
 *     `remainingCapacity = maxAllowedDeployed - totalDeployedUsdg` and
 *     `maxAllowedDeployed` is `MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO` (95%)
 *     of `basePortfolioBalance` -- the LAST position before the cap is
 *     truncated to whatever room is left, never rejected outright just
 *     because the full 35% target wouldn't fit (only a position with ZERO
 *     room left is rejected outright).
 *   - max 3 active positions at once (`MAX_ACTIVE_POSITIONS`, unchanged);
 *   - the ETH gas reserve check is included but only enforced when
 *     `rules.ETH_GAS_RESERVE_ENABLED` is true (default false / explicitly
 *     TBD per spec) -- see `types.ts`.
 *
 * Canonical worked example (basePortfolioBalance = 1000, cap = 950):
 * position #1 target = 350 (remaining 950) -> actual 350, deployed 350;
 * position #2 target = 350 (base UNCHANGED at 1000, remaining 950-350=600)
 * -> actual 350, deployed 700; position #3 target = 350 (remaining
 * 950-700=250) -> TRUNCATED to actual 250, deployed 950; position #4 ->
 * rejected, `MAX_ACTIVE_POSITIONS` (3) reached. Matches Phase 10C-REVISION's
 * spec exactly -- unlike Phase 10C's free-balance-based formula, which
 * could not reproduce these numbers because a shrinking free balance made
 * target #2 well below 350 (see this function's git history / the prior
 * revision's test file for the worked proof of that discrepancy).
 *
 * `remainingCapacity` is computed with EXACT bigint (raw USDG integer)
 * subtraction, and `positionSizeUsdgRaw` is then literally that value (or
 * lower) -- never a value independently re-derived and re-rounded. This
 * makes `totalDeployedUsdg + positionSizeUsdgRaw <= maxAllowedDeployed` a
 * mathematical invariant of this function, not just an empirically-tested
 * property: if `positionSizeUsdgRaw == remainingCapacity`, the sum equals
 * `maxAllowedDeployed` exactly; if it's the (lower) target instead, the
 * sum is strictly less. No floating-point step sits between this
 * computation and the cap check, so no rounding path can ever push actual
 * exposure past the 95% cap. The `> maxAllowedDeployed` check at the
 * bottom is deliberately kept anyway, as a defense-in-depth safety net
 * against this invariant ever being broken by a future change here --
 * same "never trust silently" discipline as every other guard in this
 * module -- even though it is currently unreachable by construction.
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

  // The stable, canonical base -- see doc comment above. Free and
  // deployed capital are the SAME underlying value split across two
  // buckets; their sum is what "the portfolio" means here, never just
  // whichever bucket happens to currently be liquid.
  const basePortfolioBalance = snapshot.freeUsdgBalance + snapshot.totalDeployedUsdg;

  const targetSizeUsdgRaw = scaleByFraction(basePortfolioBalance, rules.POSITION_SIZE_PCT_OF_FREE_BALANCE);
  const maxAllowedDeployed = scaleByFraction(basePortfolioBalance, rules.MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO);
  const remainingCapacityUsdgRaw = maxAllowedDeployed - snapshot.totalDeployedUsdg;

  const positionSizeUsdgRaw = targetSizeUsdgRaw < remainingCapacityUsdgRaw ? targetSizeUsdgRaw : remainingCapacityUsdgRaw;

  if (positionSizeUsdgRaw <= 0n) {
    return {
      ok: false,
      reason:
        targetSizeUsdgRaw <= 0n
          ? `computed target position size is not positive (base portfolio balance: ${basePortfolioBalance})`
          : `no remaining capacity toward the ${(rules.MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO * 100).toFixed(0)}% global exposure cap ` +
            `(target ${targetSizeUsdgRaw}, already deployed ${snapshot.totalDeployedUsdg}, cap ${maxAllowedDeployed} of base portfolio balance ${basePortfolioBalance})`,
    };
  }

  // Defense-in-depth only -- see doc comment above for the proof this can
  // never actually trigger given `positionSizeUsdgRaw`'s derivation.
  const projectedTotalDeployed = snapshot.totalDeployedUsdg + positionSizeUsdgRaw;
  if (projectedTotalDeployed > maxAllowedDeployed) {
    return {
      ok: false,
      reason:
        `deploying ${positionSizeUsdgRaw} would bring total deployed to ${projectedTotalDeployed}, ` +
        `exceeding the ${(rules.MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO * 100).toFixed(0)}% cap ` +
        `(${maxAllowedDeployed}) of base portfolio balance (${basePortfolioBalance})`,
    };
  }

  return { ok: true, positionSizeUsdgRaw };
}

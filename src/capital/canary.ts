import { scaleByFraction } from './decideCapitalAllocation';

/**
 * Phase 10A: canary mode's own rules, read from `config.rules.canary`
 * (never invented here) -- kept as an explicit parameter, same "pure
 * function, config-oblivious" discipline `decideCapitalAllocation` and
 * `checkEthGasReserve` already use, so every branch is unit-testable
 * without depending on the frozen `config` singleton.
 */
export interface CanaryRules {
  enabled: boolean;
  /** Fraction 0-1 of free USDG balance. `null` = this cap is not configured. */
  maxPositionPct: number | null;
  /** Absolute cap, raw USDG units. `null` = this cap is not configured. */
  maxUsdgRaw: bigint | null;
  maxPositions: number;
  stopAfterSuccess: boolean;
}

/**
 * Narrows an already-decided `decideCapitalAllocation` position size
 * against canary's own caps -- NEVER widens it. A strict identity function
 * when canary is disabled (requirement: "when disabled, runtime behavior
 * must remain exactly the same as current production behavior"), so this
 * can safely wrap every call site with zero effect until an operator
 * explicitly turns canary on.
 *
 * When both `maxPositionPct` and `maxUsdgRaw` are set, the LOWER applicable
 * limit wins (requirement: "use the lower applicable limit"). Neither cap
 * can ever push the result above what `decideCapitalAllocation` already
 * approved (requirement: "never exceed production capital safety limits")
 * -- this function only ever takes a `min()`, never adds.
 */
export function applyCanaryPositionCap(positionSizeUsdgRaw: bigint, freeUsdgBalance: bigint, canary: CanaryRules): bigint {
  if (!canary.enabled) return positionSizeUsdgRaw;

  let capped = positionSizeUsdgRaw;
  if (canary.maxPositionPct !== null) {
    const pctCap = scaleByFraction(freeUsdgBalance, canary.maxPositionPct);
    if (pctCap < capped) capped = pctCap;
  }
  if (canary.maxUsdgRaw !== null && canary.maxUsdgRaw < capped) {
    capped = canary.maxUsdgRaw;
  }
  return capped;
}

/**
 * True if canary mode still permits a new entry this cycle. Always `true`
 * when canary is disabled (no effect on production behavior). When
 * enabled, `positionsOpenedUnderCanary` -- the count of canary-mode
 * deployments recorded so far by a `CanaryGuard` -- is compared against
 * `maxPositions` (fixed at 1); once reached, this returns `false`
 * regardless of `stopAfterSuccess` (canary mode's `MAX_POSITIONS` is
 * itself always a hard cap, `stopAfterSuccess` only governs whether the
 * cap, once hit, can ever be reset automatically -- it never can; see
 * `CanaryGuard`'s doc comment).
 */
export function canaryAllowsNewEntry(canary: CanaryRules, positionsOpenedUnderCanary: number): boolean {
  if (!canary.enabled) return true;
  return positionsOpenedUnderCanary < canary.maxPositions;
}

/**
 * Tracks how many positions canary mode has successfully opened, across
 * screening cycles -- the state `canaryAllowsNewEntry` checks against.
 * Deliberately a narrow port (not the full `PositionRepository`) so the
 * real implementation can start as simple in-process state: canary mode
 * defaults OFF and requires an operator to deliberately enable it via env
 * (`CANARY_ENABLED=true`) before every deploy, so a process restart
 * requiring that same deliberate re-enable is a safe -- not a leaky --
 * reset point, never an automatic one (`stopAfterSuccess` requirement #4:
 * "no second entry may occur automatically").
 */
export interface CanaryGuard {
  succeededCount(): number;
  recordSuccess(): void;
}

export class InMemoryCanaryGuard implements CanaryGuard {
  private count = 0;

  succeededCount(): number {
    return this.count;
  }

  recordSuccess(): void {
    this.count += 1;
  }
}

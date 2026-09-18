export interface CapitalSnapshot {
  /** Wallet's current USDG token balance, raw units. Deployed USDG has physically left the wallet
   * (it's locked in the position's NFT via `PositionManager.modifyLiquidities()`), so this IS the
   * free/available balance directly -- no separate subtraction needed. */
  freeUsdgBalance: bigint;
  activePositionsCount: number;
  /** Sum of the original deployed size (at entry) of every currently-active position, raw USDG units. */
  totalDeployedUsdg: bigint;
  /**
   * Native ETH balance, raw wei. Optional -- only required when
   * `config.rules.capital.ETH_GAS_RESERVE_ENABLED` is true (default
   * false / TBD per spec). Wired now so enabling the reserve later needs
   * no refactor here, per the explicit Module 1 instruction.
   */
  ethBalance?: bigint;
}

/**
 * The subset of `config.rules.capital`'s shape `decideCapitalAllocation`
 * actually reads. Passed as an explicit, required parameter (Module 10)
 * rather than read from `config` internally -- `MAX_ACTIVE_POSITIONS` and
 * `POSITION_SIZE_PCT_OF_FREE_BALANCE` are live-editable via `settings/`
 * (re-read fresh every screening cycle by `screeningCycle.ts`, merged over
 * frozen `config.rules.capital` for every other field). `typeof
 * config.rules.capital` structurally satisfies this (it's a superset), so
 * any call site that hasn't opted into live settings (tests, anything
 * outside the composition root) can pass it directly, unconverted.
 */
export interface CapitalRules {
  MAX_ACTIVE_POSITIONS: number;
  /**
   * Phase 10C-REVISION: despite the field name (kept for historical/
   * `settings/` API-surface compatibility -- see `settings/types.ts`),
   * `decideCapitalAllocation` applies this fraction to the STABLE
   * `basePortfolioBalance` (free + deployed), never to the current/
   * shrinking free balance alone. See that function's doc comment for the
   * full worked example and rationale.
   */
  POSITION_SIZE_PCT_OF_FREE_BALANCE: number;
  MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: number;
  ETH_GAS_RESERVE_ENABLED: boolean;
  ETH_GAS_RESERVE_MIN: number;
}

export type CapitalAllocationResult =
  | { ok: true; positionSizeUsdgRaw: bigint }
  | { ok: false; reason: string };

/**
 * Port: assembles a `CapitalSnapshot`. No concrete implementation ships
 * in this module -- `activePositionsCount`/`totalDeployedUsdg` depend on
 * `positions/` (not built yet), so a real implementation can only be
 * written once that module tracks position state. `freeUsdgBalance` alone
 * IS buildable now (see `usdgBalanceReader.ts`) and is exposed as a
 * standalone utility for whatever composes the real provider later,
 * rather than being wrapped in a half-correct `CapitalSnapshotProvider`
 * that silently reports totalDeployedUsdg=0.
 */
export interface CapitalSnapshotProvider {
  getSnapshot(): Promise<CapitalSnapshot>;
  /**
   * P1-1: the RAW on-chain USDG balance (no OPENING reservation subtracted)
   * -- the only balance input `PositionRepository.createIfCapitalAllows`
   * accepts, so its write-time re-check can derive free capital from the
   * SAME row set it validates under `CapitalLock` (see
   * `capital/freshCapitalSnapshot.ts`). Never pass `getSnapshot()`'s
   * already-derived `freeUsdgBalance` there instead.
   */
  readOnChainUsdgBalance(): Promise<bigint>;
}

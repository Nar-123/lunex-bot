/**
 * All locked business-logic parameters for Lunex Bot, in one place.
 *
 * These values come directly from the functional spec and are intentionally
 * NOT scattered across modules. If a number here needs to change, it should
 * only ever need to change here.
 *
 * A few parameters are explicitly UNLOCKED / TBD per spec (e.g. the ETH gas
 * reserve). Those are called out below and read from `env` with an
 * explicit, clearly-named disabled default rather than a guessed value.
 */
import { env } from './env';
import { CAPITAL_HARD_CEILINGS } from '../capital/hardCeilings';

// ---------------------------------------------------------------------------
// 1. Candidate Discovery
// ---------------------------------------------------------------------------
export const DISCOVERY = {
  SOURCE: 'GMGN',
  TIMEFRAME: '6H',
  TOP_N: 10,
  CYCLE_INTERVAL_MS: 30 * 60 * 1000, // 30 minutes
} as const;

/**
 * chainId -> GMGN chain slug. GMGN's CLI/API identify chains by a slug
 * (e.g. "eth", "sol", ...) rather than an EVM chainId, so every GMGN call
 * needs this mapping. Kept as one explicit table so the slug string is
 * never hardcoded/duplicated across discovery/ files.
 */
export const GMGN_CHAIN_SLUGS: Record<number, string> = {
  4663: 'robinhood', // Robinhood Chain
};

export function getGmgnChainSlug(chainId: number): string {
  const slug = GMGN_CHAIN_SLUGS[chainId];
  if (!slug) {
    throw new Error(
      `No GMGN chain slug configured for chainId ${chainId}. Add an entry to GMGN_CHAIN_SLUGS in src/config/constants.ts.`,
    );
  }
  return slug;
}

// ---------------------------------------------------------------------------
// 2. Token Screening (hard filters — ALL must pass)
// ---------------------------------------------------------------------------
export const FILTERS = {
  MIN_MARKET_CAP_USD: 1_000_000,
  MIN_TOKEN_AGE_MS: 1 * 24 * 60 * 60 * 1000, // 1 day
  MIN_VOLUME_USD: 0, // volume must be strictly > 0
  MIN_TOTAL_FEE_ETH: 0.5, // all-time, sourced from GMGN
  MAX_TOP10_HOLDER_CONCENTRATION: 0.4, // top 10 non-LP/non-burn wallets, combined, < 40% supply — taken directly from GMGN data, no separate on-chain query
  ALLOWED_ASSET_TYPES: ['Meme', 'Project'] as const,
  REJECTED_ASSET_TYPES: [
    'Stock',
    'ETF',
    'Index',
    'RWA',
    'Tokenized Equity',
    'Wrapped Stock',
    'Unknown',
  ] as const,
  /**
   * `ALLOWED_ASSET_TYPES` / `REJECTED_ASSET_TYPES` above are Draft V1's
   * ORIGINAL spec-locked allow-list rule, preserved EXACTLY as they always
   * meant -- never silently repurposed. They remain the live definition of
   * `'ALLOW_LIST'` mode below (historical reference / rollback path), but
   * `'ALLOW_LIST'` is NOT the current default -- see `ASSET_TYPE_MODE`.
   *
   * HISTORY (2026-09-14):
   * 1. Live verification (gmgn-cli 1.6.2, `market trending --raw` against
   *    the real GMGN OpenAPI) found GMGN supplies NO asset-type, category,
   *    or equivalent classification field at all -- not "returns an
   *    unrecognized value" (which `'Unknown'` was designed to catch, per
   *    `gmgnMapper.ts`'s `normalizeAssetType`), but "the field is entirely
   *    absent." Every live candidate mapped to `'Unknown'`, rejected by
   *    this filter regardless of merit -- ENABLED was temporarily set to
   *    `false` (analysis + approval in that phase's session notes) so
   *    `checkAssetType` stayed intact and fully reported, just non-blocking.
   * 2. Follow-up research located a REAL, non-heuristic secondary signal:
   *    every verified Robinhood Stock Token is deployed as an EIP-1967
   *    `BeaconProxy` pointing at one shared Robinhood-controlled
   *    implementation contract -- a structural on-chain fact, not a
   *    third party's opinion, and confirmed (live, this chain) to NOT be
   *    fooled by a ticker-squatting impostor ("AAPL Cat" resolves to an
   *    unrelated implementation). See `discovery/robinhoodStockClassifier.ts`.
   * 3. `ENABLED` was restored to `true`: this check can confirm the
   *    highest-risk case (an official Robinhood Stock Token) with
   *    certainty, but it can ONLY ever produce a REJECT-confirming
   *    answer -- `NON_STOCK` is never proof of `'Meme'`/`'Project'`
   *    (Robinhood Chain is permissionless; independent third parties
   *    deploy their OWN tokenized RWAs outside Robinhood's own registry).
   *    Under `ALLOW_LIST` mode, nothing found anywhere establishes a
   *    POSITIVE Meme/Project signal, so `'Unknown'` stayed rejected per
   *    Draft V1's original fail-closed intent. Exhaustive multi-phase
   *    research (Phase 11/11B/11C) into first-party, on-chain-structural,
   *    and editorial-aggregator sources found none address-bound and
   *    authoritative enough to safely automate.
   * 4. PHASE 12 (2026-09-15) -- OPERATOR-APPROVED SPECIFICATION REVISION,
   *    not a bug fix: `Draft V1` §3's positive-classification requirement
   *    is deliberately REVISED (the "Option B" path the Phase-11-era
   *    decision record named as the only way to reopen this). New default
   *    mode is `'STOCK_ONLY'`:
   *      OLD (`ALLOW_LIST`, Draft V1 §3 original): Meme/Project allowed,
   *        every other type (including Unknown) rejected.
   *      NEW (`STOCK_ONLY`, Phase 12): only a CONFIRMED Robinhood Stock
   *        Token is rejected; every other candidate (including Unknown --
   *        now understood as "not positively classified as Stock," never
   *        again as an automatic reject) continues past this gate.
   *    Reason (operator's own words): the operator chose not to keep
   *    blocking genuine crypto tokens merely because no authoritative
   *    positive Meme/Project source exists -- confirmed absent by three
   *    full research phases, not a gap this revision papers over.
   *    Uniswap V2/V3/V4 venue is explicitly NOT an asset class under
   *    either mode (unchanged, see `robinhoodStockClassifier.ts`, proven
   *    by the TWINE regression in `tests/filters/assetType.test.ts`).
   *    STOCK_ONLY mode is driven by `CandidateToken.stockClassification`
   *    (the classifier's own three-value result: `ROBINHOOD_OFFICIAL_STOCK`
   *    / `NON_STOCK` / `UNKNOWN`), NOT by the flattened `assetType`
   *    string -- deliberately, so a classifier RPC failure or malformed
   *    beacon read (`UNKNOWN`) is REJECTED, never silently treated as
   *    "not stock, therefore safe." See `filters/rules/assetType.ts`'s
   *    doc comment for the exact fail-safe logic.
   *
   * `screenCandidate()` (`filters/screenCandidate.ts`) still supports an
   * explicit `assetTypeEnabled` override for tests; production always
   * reads `ASSET_TYPE.ENABLED`/`ASSET_TYPE_MODE` from this constant.
   * `composition/screeningCycle.ts` still logs a prominent
   * `asset_type_filter_disabled` warning every cycle IF `ENABLED` is ever
   * flipped back to `false` -- currently dormant, unaffected by the mode
   * change above.
   */
  ASSET_TYPE: {
    ENABLED: true,
  },
  /**
   * Phase 12 (2026-09-15), operator-approved: `'STOCK_ONLY'` is the new
   * default -- reject only a confirmed Robinhood Stock Token, allow every
   * other outcome (including a classifier result of `NON_STOCK` OR a
   * candidate whose `assetType` is `'Unknown'`) to continue past this
   * gate. `'ALLOW_LIST'` preserves the original Draft V1 §3 behavior
   * (`ALLOWED_ASSET_TYPES`/`REJECTED_ASSET_TYPES` above) for historical
   * reference / an explicit future rollback -- never removed, never
   * silently repurposed.
   */
  ASSET_TYPE_MODE: 'STOCK_ONLY' as const,
  COOLDOWN_MS: 2 * 60 * 60 * 1000, // 2 hours, per-token (NOT global)
  // Explicitly NOT a filter — do not add a honeypot check here or elsewhere.
  HONEYPOT_CHECK_INCLUDED: false,
} as const;

export type AllowedAssetType = (typeof FILTERS.ALLOWED_ASSET_TYPES)[number];
export type RejectedAssetType = (typeof FILTERS.REJECTED_ASSET_TYPES)[number];

// ---------------------------------------------------------------------------
// 3. Pool Selection (TOKEN/USDG pools) — Uniswap v4 ONLY
// ---------------------------------------------------------------------------
// SUPERSEDES the earlier fee-tier-by-volume design (3%/4%/5% selected from
// 6H volume thresholds). That design is REMOVED ENTIRELY, not deprecated —
// v4 pools carry `fee` and `tickSpacing` explicitly per `PoolKey`, so there
// is no fixed tier table to select from any more. See `pools/selectPool.ts`
// for the real flow: discover every v4 TOKEN/USDG pool, keep only pools
// with fee > 0 and estimated exit price impact <= PRICE_IMPACT.MAX_EXIT_IMPACT_PCT
// (computed via a real swap simulation against the pool's actual liquidity
// distribution, never a TVL ratio), then pick the highest-6H-volume survivor.
export const POOL_SELECTION = {
  MIN_FEE: 0, // pools with fee === 0 are rejected outright
  UNISWAP_VERSION: 'v4' as const, // v3 is never called directly — see blockchain/uniswapSdk.ts
} as const;

/**
 * The single price-impact threshold used anywhere in the system: pool
 * selection (Module 3, always enforced) AND the real-time exit impact
 * check (`EXITS.IMPACT_CHECK_ENABLED`, now ON -- Tier 3). Never define a
 * second threshold elsewhere — both call sites must read this constant.
 *
 * TIER 3 (Meridian alignment): 1% -> 0.5%. Meridian's measured
 * `maxExitPriceImpactPct: 0.5` is its single highest-leverage filter --
 * its own strategy doc records exit cost at 1.49% per round trip against
 * a pool-level edge of 0.00241 SOL/position, i.e. "cost is 3.1x the
 * edge," and names this filter as the one thing that measurably worked
 * against it ("what did work is refusing the expensive pools in the first
 * place"). Applied at BOTH entry (pool selection, as before) and exit
 * (see `EXITS.IMPACT_CHECK_ENABLED`), matching Meridian, which quotes
 * pre-flight at deploy and re-checks the real swap on the way out.
 */
export const PRICE_IMPACT = {
  MAX_EXIT_IMPACT_PCT: 0.005, // 0.5% -- Meridian `maxExitPriceImpactPct`
} as const;

/**
 * Phase 12G: `DECIMALS` MUST equal the real on-chain USDG contract's own
 * `decimals()` (confirmed `6`, not the generic-ERC20-shaped `18` this was
 * previously misconfigured as -- see `env.ts`'s doc comment on
 * `USDG_DECIMALS` for the full incident record). Every USDG `Token`/`Price`
 * construction across the codebase (`mintTx.ts`, `removeLiquidityTx.ts`,
 * `screeningCycle.ts`, `poolVolumeProvider.ts`, `computePositionMetrics.ts`)
 * trusts this value verbatim and is NOT re-validated per call site --
 * `index.ts`'s startup sequence is the single fail-fast guard that this
 * static value still matches the live chain, via
 * `blockchain/erc20.ts`'s `assertQuoteAssetDecimalsMatchOnChain`.
 */
export const QUOTE_ASSET = {
  SYMBOL: 'USDG',
  ADDRESS: env.USDG_TOKEN_ADDRESS,
  DECIMALS: env.USDG_DECIMALS,
} as const;

// ---------------------------------------------------------------------------
// 4. LP Strategy — USDG-only one-sided concentrated liquidity
// ---------------------------------------------------------------------------
export const LP_STRATEGY = {
  // Lower price = 0.5 * entry price (P)
  LOWER_PRICE_MULTIPLIER: 0.5,
  // Upper price = P (0% offset). The whole range sits at-or-below the entry
  // price so the position is genuinely single-sided USDG at deposit time.
  UPPER_PRICE_OFFSET_PCT: 0,
  // Upper tick must round DOWN to the nearest valid tick spacing so the
  // computed upper price is strictly below the live quote price at
  // execution time — never equal to or above it. This guards against a
  // partial (two-sided) fill caused by price movement between quote and
  // execution. See strategies/ module notes for the rounding implementation.
  UPPER_TICK_ROUNDING: 'DOWN_STRICT' as const,

  /**
   * P1-10 fix: `positions/mintTx.ts`'s `addCallParameters` previously used
   * `slippageTolerance: new Percent(1, 1)` -- 100%, i.e. NO minimum-input
   * protection at all. The prior judgment call ("the SIMULATED checkpoint
   * catches an outright-broken mint before broadcast either way") is still
   * true but incomplete: simulation only catches a mint that would revert
   * outright, not one that succeeds after unfavorable price movement
   * between build and mine (the same class of risk `slippageTolerance`
   * exists for on every other DEX interaction). Bounded to the SAME
   * tightest, already-vetted tier `EXITS.SLIPPAGE_TIERS_BPS`'s first entry
   * uses for the swap leg (100 bps = 1%) -- not an invented number: reusing
   * the one slippage figure this strategy has already measured/accepted
   * elsewhere, rather than guessing a mint-specific one.
   */
  MINT_SLIPPAGE_BPS: 100,
} as const;

// ---------------------------------------------------------------------------
// 5. Capital Management
// ---------------------------------------------------------------------------
export const CAPITAL = {
  // P0-2: these three defaults ARE the strategy's hard safety ceilings --
  // sourced from `capital/hardCeilings.ts`'s `CAPITAL_HARD_CEILINGS`
  // rather than re-typing the numbers here, so the "default equals
  // ceiling" relationship can never silently drift. Live settings
  // (`BotSettings`/`PATCH /settings`) may only ever move these DOWN --
  // enforced at the API layer (`api/routes/settingsSchema.ts`) and,
  // independently, inside `decideCapitalAllocation` itself via
  // `clampToHardCeilings` (defense-in-depth: no caller, legacy DB row, or
  // future bug can ever produce a position beyond these limits).
  //
  // Position size = 35% of FREE/AVAILABLE USDG balance at deployment time
  // (not 35% of the original/starting balance).
  POSITION_SIZE_PCT_OF_FREE_BALANCE: CAPITAL_HARD_CEILINGS.MAX_POSITION_SIZE_PCT,
  MAX_ACTIVE_POSITIONS: CAPITAL_HARD_CEILINGS.MAX_ACTIVE_POSITIONS,
  // Global exposure hard cap. Each entry TARGETS 35% of free balance, but
  // is truncated to whatever remaining capacity is left under this cap --
  // see `decideCapitalAllocation.ts`'s doc comment for the exact formula.
  // 90% -> 95%: an explicit operator policy update, not a relaxation of
  // the per-entry 35% target, which is unchanged.
  MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: CAPITAL_HARD_CEILINGS.MAX_TOTAL_DEPLOYED_PCT, // hard cap
  ONE_POSITION_PER_TOKEN: true,

  /**
   * ETH Gas Reserve mechanism — INTENTIONALLY UNLOCKED / NOT FINAL.
   * Per spec this must default to OFF/0 (no reserve enforced) but be
   * trivially flippable later without refactoring the capital manager.
   * Do not invent a "reasonable" default value here.
   */
  ETH_GAS_RESERVE_ENABLED: env.ETH_GAS_RESERVE_ENABLED, // default false
  ETH_GAS_RESERVE_MIN: env.ETH_GAS_RESERVE_MIN, // TBD, feature currently disabled; default 0
} as const;

// ---------------------------------------------------------------------------
// 5a. Canary Mode (Phase 10A) -- a dedicated, disabled-by-default cap for
// the FIRST live transaction, entirely separate from CAPITAL's 35%
// production default above, which this block never changes or reads from.
// MAX_POSITIONS and STOP_AFTER_SUCCESS are fixed by design (a canary run is
// a one-shot pipeline proof, not a tunable concurrency limit) -- only
// ENABLED and the two size caps are operator-configurable, and the size
// caps are deliberately `null` (never invented) until an operator sets
// them via env; `env.ts`'s superRefine already refuses to start if
// ENABLED=true with both caps unset.
// ---------------------------------------------------------------------------
export const CANARY = {
  ENABLED: env.CANARY_ENABLED, // default false
  /** Fraction 0-1 of free USDG balance (e.g. 0.01 = 1%). `null` = not configured. */
  MAX_POSITION_PCT: env.CANARY_MAX_POSITION_PCT ?? null,
  /** Absolute cap, human USDG units (e.g. 50 = 50 USDG) -- converted to raw units at the point of use via `QUOTE_ASSET.DECIMALS`. `null` = no absolute cap configured. */
  MAX_USDG: env.CANARY_MAX_USDG ?? null,
  MAX_POSITIONS: 1,
  STOP_AFTER_SUCCESS: true,
} as const;

// ---------------------------------------------------------------------------
// 6. Screening & Deployment Cycle
// ---------------------------------------------------------------------------
export const CYCLE = {
  MAX_SUCCESSFUL_DEPLOYMENTS_PER_CYCLE: 1,
  TRY_NEXT_CANDIDATE_ON_FAILURE: true,
} as const;

// ---------------------------------------------------------------------------
// 7. Position Monitoring
// ---------------------------------------------------------------------------
export const MONITORING = {
  INTERVAL_MS: 15 * 1000, // 15 seconds, independent of the screening cycle
} as const;

// ---------------------------------------------------------------------------
// 8. Exit Strategies
// ---------------------------------------------------------------------------
/**
 * TIER 3 — the exit ladder, aligned to Meridian's MEASURED strategy
 * (github.com/Nar-123/meridian-rs-master, `docs/strategy.md` §4 "Exit
 * ladder" plus the concrete defaults in `backend/src/config/types.rs`).
 * Every number below is Meridian's, not an invention; where Lunex's
 * architecture forced an adaptation it says so explicitly.
 *
 * Evaluated strictly in this order, per position, per 15s tick (see
 * `exits/resolveExitDecision.ts` -- the order is the policy):
 *
 *   1. HARD_STOP_LOSS      PnL <= -6%, AND Safety Exit not (yet) armed
 *   2. SAFETY_EXIT         armed at max-drawdown <= -8%, closes on recovery to >= 0%
 *   3. OVEREXTENDED        Bollinger %B >= 1.0 AND PnL > 0
 *   4. TRAILING_TP         arm at +6%, close on -3pp from peak, 15s confirm
 *   5. HARD_TAKE_PROFIT    PnL >= +25%
 *   6. OOR_PROFIT          out of range AND PnL >= +2%
 *   7. LOW_YIELD           age >= 30min AND fee yield below floor
 *   8. OOR_TIMEOUT / INFRA_SAFETY_EXIT  (pre-existing Lunex protections)
 */
/**
 * Chain-scoped EXIT execution targets -- the only contracts exit-swap calldata
 * may be sent to, and the only routers a SwapProxy payload may name.
 *
 * Robinhood Chain (4663); every address below was confirmed from Uniswap's own
 * published sources AND on-chain before being listed:
 *
 *  - UniversalRouter 0x8876...0904: listed as "Universal Router 2.1.1" for
 *    chain 4663 in Uniswap's Trading API supported-chains table (that chain has
 *    no 2.0 deployment); on-chain it carries Universal Router bytecode and its
 *    `poolManager()` returns the configured PoolManager.
 *  - SwapProxy 0x0000000085E1...Affad: the deterministic CREATE2 SwapProxy
 *    documented for the `x-permit2-disabled` proxy approval flow ("the same
 *    address on every chain"), listed as SwapProxy for chain 4663 in Uniswap's
 *    deployments.json, and deployed on chain 4663 with bytecode identical to
 *    the proxy the API currently targets.
 *
 * DELIBERATELY NOT LISTED (see the exit-router investigation):
 *  - 0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9 -- the previous,
 *    non-deterministic SwapProxy. Uniswap's own documentation says it "is
 *    deprecated. Integrators still pointing at it should migrate". The live API
 *    still returns it for this chain; that is a provider-side migration gap,
 *    not a reason to authorise it here.
 *  - 0x204FAca1764B154221e35c0d20aBb3c525710498 -- the router the API currently
 *    embeds in proxy calldata. It is Universal-Router-shaped and bound to the
 *    correct PoolManager on-chain, but NO official Uniswap source lists it for
 *    chain 4663 (the docs name 0x8876..., deployments.json names 0x06AfBA43...).
 *    Unverified provenance is not approval.
 * Either may be added only by a separately verified deployment decision.
 */
export const EXECUTION_TARGETS: Record<number, { universalRouters: readonly string[]; swapProxies: readonly string[] }> = {
  4663: {
    universalRouters: ['0x8876789976dEcBfCbBbe364623C63652db8C0904'],
    swapProxies: ['0x0000000085E102724e78eCd2F45DC9cA239Affad'],
  },
};

export const EXITS = {
  // ---- Priority 1 ---------------------------------------------------
  /**
   * Meridian `-6%`. Its strategy doc is explicit that this is the only
   * exit path that loses money and that widening it is the WRONG reading
   * ("the stop-loss is simply where losses get realised... MANLET went
   * from +22% to -40% precisely because it could not be cut"). Was -15%
   * in Lunex -- an invented placeholder, never a spec value.
   */
  HARD_STOP_LOSS_PCT: -0.06,

  // ---- Priority 2 ---------------------------------------------------
  /**
   * Meridian `safety_exit_trigger_pct: -8.0` / `safety_exit_tp_pct: 0.0`.
   * Arms (stickily) once a position's MAXIMUM DRAWDOWN reaches -8%, then
   * waits for a recovery to breakeven rather than closing into the hole.
   * Supersedes Lunex's old `PNL_PROTECTION`, which had the same -8%/0%
   * numbers but only RETARGETED Trailing TP's arm threshold instead of
   * closing -- a strictly weaker expression of the same intent.
   *
   * P0-2026 UPDATE -- interaction with Priority 1: previously (the
   * original Meridian-ladder shipment), with the stop at -6% and this
   * arming at -8%, any PnL reading that armed this rule was also at or
   * below the stop on that SAME tick, and the stop won unconditionally
   * (Priority 1) -- making this rule's own "wait for recovery" semantics
   * unreachable under ordinary smooth decline. Confirmed with the operator
   * and changed: `exits/resolveExitDecision.ts` now has HARD_STOP_LOSS
   * itself check `safetyExitArmedAt === null` before closing, so once this
   * rule arms (this tick or a prior one) Priority 1 yields to it instead
   * of overriding it. This does NOT make smooth continuous decline reach
   * -8% (a tick-by-tick fall still crosses -6% first and stops out there,
   * same as before -- an accepted limitation of a discrete 15s-tick check,
   * not something this fix claims to solve). What it fixes: (a) a genuine
   * same-tick price gap/jump that skips straight past -6% to -8%-or-deeper
   * in one reading, (b) a stop-triggered exit that failed definitively and
   * reverted the position to ACTIVE (`executeExit.ts`), where the NEXT
   * reading has fallen further and now reaches -8% directly, and (c) the
   * stop being live-widened past -8% via `BotSettings.hardStopLossPct`
   * (unaffected by this fix -- always worked). See
   * `exits/resolveExitDecision.ts`'s doc comment for the full mechanism.
   */
  SAFETY_EXIT: {
    ENABLED: true,
    TRIGGER_PCT: -0.08, // arm once max drawdown <= this
    TARGET_PCT: 0, // once armed, close as soon as PnL >= this
  },

  // ---- Priority 3 ---------------------------------------------------
  /**
   * Meridian's "Over-extended TP", measured as its BEST exit ("captures
   * the peak almost exactly -- 11.5%->11.4%, 13.5%->13.45%. Largest net
   * contributor"). Bollinger %B >= 1.0 means price has pierced the upper
   * band; combined with PnL > 0 it banks a bounce without ever realising
   * a loss. RSI is deliberately NOT part of this: Meridian disables it by
   * setting its threshold to 101 (unreachable), so %B alone decides.
   *
   * BB parameters are Meridian's exactly: 20 periods, 5-minute candles,
   * SMA +/- 2 sigma (`backend/src/tools/bollinger.rs`: `BB_PERIOD = 20`,
   * `default_indicator_intervals() -> ["5_MINUTE"]`, `upper = mean + 2sd`).
   * ADAPTATION: Meridian reads OHLCV from an external chart-indicators
   * API keyed by token mint; no such feed exists for Robinhood Chain, so
   * `monitoring/priceHistory*` builds the 5-minute closes from Lunex's own
   * 15s pool-price polls. Until 20 buckets exist the metric is simply
   * unavailable and this rule cannot fire -- never fabricated.
   */
  OVEREXTENDED: {
    ENABLED: true,
    BB_PERCENT_B: 1.0, // Meridian `exit_bb_upper_pctb`
    BB_PERIOD: 20, // Meridian `BB_PERIOD`
    BB_STDDEV_MULTIPLIER: 2, // Meridian `mean +/- 2.0 * sd`
    BB_BUCKET_MS: 5 * 60 * 1000, // Meridian `5_MINUTE` candles
  },

  // ---- Priority 4 ---------------------------------------------------
  /**
   * Meridian "arm at +6%, sell on -3% from peak" (`docs/strategy.md` §4).
   * DRAWDOWN_FROM_PEAK_PCT is an absolute PERCENTAGE-POINT drop from the
   * peak, NOT a multiplicative haircut: peak +11% closes at +8%, never at
   * +10.67%. (Lunex's arithmetic was already point-based -- `peak - drop`
   * on fractions -- only the numbers change here: +5%/-2% -> +6%/-3%.)
   * The 15s confirmation window is unchanged and matches Meridian's own
   * `pnlPollIntervalSecs: 15`.
   */
  TRAILING_TP: {
    ENABLED: true,
    TRIGGER_PEAK_PNL_PCT: 0.06, // arm once PnL reaches +6%
    DRAWDOWN_FROM_PEAK_PCT: 0.03, // close after a 3-percentage-point fall from peak
    CONFIRM_WINDOW_MS: 15 * 1000, // confirmation timer once the drawdown line is breached
  },

  // ---- Priority 5 ---------------------------------------------------
  /**
   * Meridian `+25%` -- its doc calls this "effectively decorative (one
   * position in all of history has reached it)", but it remains a hard
   * ceiling that closes without waiting for any confirmation window.
   */
  HARD_TAKE_PROFIT_PCT: 0.25,

  // ---- Priority 6 ---------------------------------------------------
  /**
   * Meridian "OOR in profit": out of range AND >= `exitMinProfitPct (2%)`.
   * Out-of-range capital earns no fees, so a profitable one is banked
   * rather than left idle. Strictly below the risk/profit rules above.
   */
  OOR_PROFIT: {
    ENABLED: true,
    MIN_PNL_PCT: 0.02,
  },

  // ---- Priority 7 ---------------------------------------------------
  /**
   * Meridian "Low yield": `min_fee_per_tvl_24h` checked only after
   * `minAgeBeforeYieldCheck: 30` minutes (the measured config in
   * `docs/strategy.md` §4; the code default of 60 is superseded by it).
   * The age floor is deliberate -- a fresh position has not had time to
   * earn anything, so checking early would close every position on sight.
   *
   * DISABLED BY DEFAULT -- VALIDATION-PHASE RESOLUTION of the Tier 3
   * metric mismatch. Meridian's metric is POOL-level fees/TVL over a
   * trailing 24h window, supplied by Meteora's API. Lunex has NO pool-
   * level fee or TVL data source at all (audited: `pools/` reads raw
   * `getLiquidity` units, not a USD TVL; `poolVolumeProvider.ts` derives
   * 6h VOLUME from Swap logs, not fees; discovery's `gas_fee` is a
   * token-level all-time figure in native currency). Meridian's exact
   * metric therefore cannot be reproduced here, and per the resolution
   * brief no substitute metric may be shipped under this rule's name.
   *
   * What the rule's wiring ACTUALLY computes today, if re-enabled: this
   * position's OWN cumulative uncollected fees divided by its entry
   * capital (`computePositionMetrics`'s `yieldPct` -- v4 fee-growth
   * accounting, since entry, not annualized, not a 24h window, not
   * pool-level). That is a different quantity from Meridian's number, and
   * the direction of the difference depends on position age (a young
   * position under-reads against the 0.0005 floor, an old one over-reads),
   * so the same threshold cannot meaningfully gate it. Re-enabling
   * requires a real pool-level fee/TVL feed with 24h normalization to be
   * wired into `ExitMetricsSnapshot.yieldPct` FIRST, and validated -- the
   * single `ENABLED` flag below is then the only remaining switch.
   *
   * The rule, its reason string, its ladder position, and Meridian's two
   * parameter values below are all kept intact -- disabling a rule is a
   * policy default, not a removal.
   */
  LOW_YIELD: {
    ENABLED: false,
    MIN_AGE_MS: 30 * 60 * 1000, // Meridian `minAgeBeforeYieldCheck: 30` minutes
    MIN_FEE_YIELD_PCT: 0.0005, // Meridian `min_fee_per_tvl_24h`
  },

  // ---- Priority 8: pre-existing Lunex protections --------------------
  OOR: {
    GRACE_WINDOW_MS: 30 * 60 * 1000, // 30 minutes out-of-range before closing (unprofitable OOR)
  },

  /**
   * Lunex's ORIGINAL "Safety Exit" -- renamed in Tier 3 to free the
   * `SAFETY_EXIT` name for Meridian's drawdown-recovery rule above. This
   * one is NOT a strategy rule at all: it handles abnormal INFRASTRUCTURE
   * conditions, and is deliberately preserved unchanged (Tier 3 brief:
   * "remaining safety rules"). Two conditions:
   *  (a) this position's live metrics have failed to read successfully,
   *      continuously, for longer than MAX_METRICS_FAILURE_MS (persisted
   *      via ExitState.metricsFailureSince, since a restart must not reset
   *      the streak to zero) -- and, per the Tier 2 H4 fix, only when that
   *      failure is NOT correlated across every active position (a shared
   *      RPC outage must never liquidate the whole portfolio);
   *  (b) a pool price read that's structurally impossible to trust
   *      (sqrtPriceX96 <= 0 or tickCurrent outside TickMath's valid range)
   *      — triggers immediately, no timer, since the data itself can't be
   *      used to compute anything meaningful.
   * See exits/safetyExit.ts.
   */
  INFRA_SAFETY_EXIT: {
    ENABLED: true,
    MAX_METRICS_FAILURE_MS: 5 * 60 * 1000, // 5 minutes — between the 15s monitoring tick and the 30min OOR grace window
  },

  /**
   * A repeatedly-failing exit swap is invisible to execution/'s own
   * stuck-attempt detection (stuckAttempt.ts): every retry deliberately
   * gets a FRESH idempotencyKey (see exits/executeExit.ts's doc comment),
   * so no single TransactionAttempt row's attemptCount ever climbs high
   * enough to flag it. ExitState.swapAttemptCount tracks this
   * independently, position-scoped. This threshold is queryable
   * (exits/safetyExit.ts's `isSwapRetryStuck`,
   * ExitStateRepository.findStuckSwapRetries) but deliberately does NOT
   * feed into any close/retry decision on its own — a stuck swap means
   * "someone should be able to see this," not "stop retrying."
   */
  /**
   * TIER 3: lowered 5 -> 3 so the operator-visible "stuck swap" warning
   * fires exactly when every slippage tier below has been exhausted,
   * rather than two definitive failures later. See SLIPPAGE_TIERS_BPS.
   */
  /**
   * OPERATOR-APPROVED DUST SETTLEMENT (exits/dustSettlement.ts).
   *
   * A TOKEN residual is "dust" only when selling it CANNOT PAY FOR ITS OWN
   * GAS -- never because the quantity looks small. The value is always taken
   * from a fresh read-only quote for the exact residual, so token decimals and
   * price are handled by the quote itself rather than by any hardcoded scale.
   *
   * Economic rationale for the default (measured on Robinhood Chain,
   * 2026-09-20): the cheapest possible exit swap is ~350k gas, and at the
   * observed ~62.2 gwei that is ~0.056 USDG; a bare ERC20 approve is another
   * ~0.009 USDG. A residual worth less than the gas needed to sell it can only
   * LOSE value by being sold. 0.02 USDG sits at ~36% of that swap cost, so
   * even if gas fell ~3x the threshold would still be below the cost of
   * selling, while being far above the two residuals this policy exists for
   * (0.008712 and 0.000536 USDG).
   *
   * Raising this is an economic decision, not a tuning knob: every raw unit of
   * increase is value the bot may abandon instead of recovering.
   */
  DUST_SETTLEMENT: {
    /** Raw USDG (quote-output units). A residual must be STRICTLY below this to qualify. */
    MAX_USDG_VALUE_RAW: 20_000n, // 0.02 USDG at 6 decimals
    /** A quote older than this is refused -- a dust decision is only ever made on a fresh price. */
    QUOTE_MAX_AGE_MS: 60 * 1000,
    /** Slippage tier used when ASKING for the valuation quote (nothing is executed; this only picks a quote shape). */
    QUOTE_SLIPPAGE_BPS: 100,
  },

  SWAP_RETRY: {
    STUCK_THRESHOLD: 3, // = SLIPPAGE_TIERS_BPS.length: all tiers spent
  },

  /**
   * Backoff for a DETERMINISTIC swap-leg block (unapproved execution target,
   * unapproved embedded router, undecodable proxy calldata, unapproved
   * approval spender). Such a failure states something about CONFIGURATION,
   * not about market conditions: retrying identical inputs every 15s cannot
   * succeed, and each attempt costs two Trading API calls. The ladder is a
   * function of how long the SAME failure fingerprint has stood, so it needs
   * no extra persisted state and survives restarts. Transient blocks
   * (QUOTE_UNAVAILABLE, PRICE_IMPACT_BLOCKED) are NOT affected -- their cause
   * can change on its own, so they keep retrying every tick.
   */
  DETERMINISTIC_BLOCK_BACKOFF: {
    /** [blocked-for-at-least-ms, retry-no-more-often-than-ms]; the last matching step wins. */
    LADDER_MS: [
      [0, 15 * 1000],
      [60 * 1000, 60 * 1000],
      [5 * 60 * 1000, 5 * 60 * 1000],
      [15 * 60 * 1000, 15 * 60 * 1000],
    ] as readonly (readonly [number, number])[],
    /** Once the same deterministic block has stood this long, the position is surfaced as OPERATOR_ACTION_REQUIRED (same age policy the existing stuck surfacing uses). */
    OPERATOR_ACTION_AFTER_MS: 10 * 60 * 1000,
  },

  /**
   * TIER 3: ON. Price impact is computed for every exit swap and compared
   * against `PRICE_IMPACT.MAX_EXIT_IMPACT_PCT` (0.5%) — the exact same
   * constant `pools/selectPool.ts` enforces at pool-selection time. Never
   * introduce a second threshold here.
   *
   * This is checked at EXIT time against a FRESH quote, not inherited from
   * the entry-time filter: a pool that was cheap to leave at deploy can be
   * expensive hours later, and that is precisely the case this catches. An
   * impact the provider does not report is treated as UNVERIFIED and
   * defers the swap (resumable) -- never as a pass.
   */
  IMPACT_CHECK_ENABLED: env.EXIT_IMPACT_CHECK_ENABLED, // TIER 3 default: true

  /**
   * Post-hoc minimum-received verification (a balance-delta check after
   * the swap confirms). Independent of the on-chain slippage bound, which
   * is ALWAYS applied now via SLIPPAGE_TIERS_BPS below -- see
   * `swap/tradingApiClient.ts`.
   */
  MIN_RECEIVED_PROTECTION_ENABLED: env.EXIT_MIN_RECEIVED_PROTECTION_ENABLED, // default false

  /**
   * TIER 3 — Meridian's escalating exit slippage
   * (`backend/src/tools/executor.rs`: attempt 1 => 100, 2 => 200, _ => 300
   * bps), replacing Lunex's single flat 1% placeholder.
   *
   * The intent is "take the tight price when the market allows, widen only
   * for tokens that refuse to fill, never leave a token unswapped" -- NOT
   * "always use 3%". The tier index is `ExitState.swapAttemptCount`, which
   * (Module 8, unchanged) is incremented ONLY on a DEFINITIVE failure:
   *  - an ambiguous/resumable attempt never advances the tier, so a
   *    restart mid-flight resumes the SAME tier under the SAME
   *    idempotency key rather than re-broadcasting one tier wider;
   *  - the tier is therefore persisted for free, with no new state.
   * Past the last tier the index clamps (stays at 300 bps) and
   * SWAP_RETRY.STUCK_THRESHOLD surfaces it to the operator -- the TOKEN
   * balance is never abandoned.
   */
  SLIPPAGE_TIERS_BPS: [100, 200, 300] as readonly number[],

  /**
   * P1-11 fix: `exits/removeLiquidityTx.ts`'s `removeCallParameters`
   * previously used `slippageTolerance: new Percent(1, 1)` -- 100%, no
   * minimum-output protection on the remove-liquidity leg. Bounded to the
   * SAME tightest tier as `SLIPPAGE_TIERS_BPS[0]` (100 bps = 1%) for the
   * same reason as `LP_STRATEGY.MINT_SLIPPAGE_BPS` -- reusing an
   * already-vetted number rather than inventing a new one. Deliberately
   * NOT the swap leg's escalating ladder: remove-liquidity is a single
   * burn-to-both-sides operation (no retry-tier concept), and a legitimate
   * close must not be blocked by a tight bound -- 1% is loose enough that
   * normal confirmation-time price movement does not spuriously revert it,
   * while still catching a genuinely broken/manipulated execution.
   */
  REMOVE_LIQUIDITY_SLIPPAGE_BPS: 100,
} as const;

// ---------------------------------------------------------------------------
// 9. Exit Flow (ordering contract, referenced by execution/exits modules)
// ---------------------------------------------------------------------------
export const EXIT_FLOW_STEPS = [
  'EXIT_SIGNAL',
  'REMOVE_LIQUIDITY',
  'COLLECT_FEES',
  'DETERMINE_TOKEN_BALANCE',
  'QUOTE_TOKEN_TO_USDG',
  'SWAP_TOKEN_TO_USDG',
  'VERIFY_USDG_ONCHAIN',
  'POSITION_CLOSED',
] as const;

// ---------------------------------------------------------------------------
// 10. Transaction Safety (applies to ALL critical transactions: deploy & exit)
// ---------------------------------------------------------------------------
export const TX_SAFETY_STEPS = [
  'BUILD_TRANSACTION',
  'SIMULATION',
  'GAS_CHECK',
  'NONCE_CHECK',
  'SEND',
  'WAIT_RECEIPT',
  'VERIFY_ONCHAIN',
  'UPDATE_STATE',
] as const;

export const TX_SAFETY = {
  // A tx must never be marked failed locally without confirming on-chain
  // state first; a bot restart mid-flow must resume/verify, never replay
  // or silently mark as failed. See blockchain/ + execution/ module notes.
  REQUIRE_ONCHAIN_VERIFICATION_BEFORE_STATE_UPDATE: true,
  RESUMABLE_ON_RESTART: true,
} as const;

// ---------------------------------------------------------------------------
// 11. Cooldown
// ---------------------------------------------------------------------------
export const COOLDOWN = {
  DURATION_MS: FILTERS.COOLDOWN_MS, // 2 hours per-token, NOT global
  SCOPE: 'PER_TOKEN' as const,
} as const;

// ---------------------------------------------------------------------------
// 12. Interfaces — Telegram & UI
// ---------------------------------------------------------------------------
export const INTERFACES = {
  TELEGRAM: {
    BOT_NAME: env.TELEGRAM_BOT_NAME,
    CONTROL_AND_REPORTING_ONLY: true, // never a trading engine, never reads chain directly
    ON_DEMAND_ONLY: true, // no push notifications, ever — including for critical events
  },
  UI: {
    FULL_CONTROL: true, // live positions, parameter changes, pause/resume, logs/reports
  },
  API_IS_SINGLE_SOURCE_OF_TRUTH: true,
  NETWORK: {
    IP_WHITELIST_ENABLED: false, // all IPs allowed by design
  },
  AUTH: {
    METHOD: 'username_password' as const,
    HTTPS_REQUIRED: true,
    LOGIN_RATE_LIMIT_WINDOW_MS: env.LOGIN_RATE_LIMIT_WINDOW_MS,
    LOGIN_RATE_LIMIT_MAX_ATTEMPTS: env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
    JWT_EXPIRY: env.JWT_EXPIRY,
    REFRESH_TOKEN_EXPIRY: env.REFRESH_TOKEN_EXPIRY,
  },
} as const;

// ---------------------------------------------------------------------------
// 13. Execution — stuck-attempt detection (NOT part of the original spec;
// added after explicit review of executeCriticalTransaction's crash-recovery
// design). A `resumable: true` attempt (broadcast/receipt genuinely
// ambiguous -- network blip, RPC drop) is expected to resolve within a few
// retries/seconds under normal conditions. These thresholds are just a
// bright line for "this one has been ambiguous for suspiciously long" --
// making it queryable (e.g. a future `/status` command), NOT a trigger for
// any automatic notification (Telegram stays fully on-demand-only, per
// spec section 12). Starting values, explicitly revisable.
// ---------------------------------------------------------------------------
export const EXECUTION = {
  STUCK_ATTEMPT_MAX_RETRIES: 5,
  STUCK_ATTEMPT_MAX_AGE_MS: 10 * 60 * 1000, // 10 minutes
  /// C7 concurrency fix: how long a `Position.claimForResume()` claim
  /// stays valid before a second concurrent cycle may claim the SAME
  /// position again. Set slightly longer than the 15s exit/open-resume
  /// tick interval so a claim survives at least one full tick. After a
  /// real crash, nobody refreshes the claim, so it naturally expires and
  /// the next resume attempt (from either cycle) proceeds normally --
  /// this only prevents two cycles claiming the SAME position at the SAME
  /// moment (e.g. the 30-min screening cycle's `openPosition()` racing the
  /// 15s exit cycle's OPENING-resume pass on a brand-new position); it
  /// never blocks or delays genuine crash recovery beyond one tick.
  RESUME_CLAIM_FRESHNESS_MS: 20 * 1000,
  /// H3: maximum age of an OPENING position (measured from its persisted
  /// `Position.createdAt`, i.e. the moment its capital was reserved) after
  /// which -- and ONLY if its mint provably was never broadcast -- it is
  /// terminally marked FAILED, releasing its reserved capital, its slot
  /// and its token. Not a new number: it IS the screening cadence
  /// (`DISCOVERY.CYCLE_INTERVAL_MS`), by reference, because the entry
  /// flow's own documented policy (`positions/openPosition.ts`) is that a
  /// candidate that cannot complete is NOT retried on stale parameters --
  /// "the correct retry is the NEXT screening cycle evaluating fresh
  /// candidates against fresh prices". An OPENING reservation older than
  /// one cycle is therefore holding capital for a decision the strategy
  /// already considers superseded. Change it here (or change the cadence)
  /// -- never hardcode a separate value elsewhere. See `positions/openingTimeout.ts`.
  OPENING_MAX_AGE_MS: DISCOVERY.CYCLE_INTERVAL_MS,
  /// Legacy gasPrice headroom (see execution/gasPrice.ts). Robinhood Chain's
  /// `eth_gasPrice` equals the current base fee exactly and the base fee moves
  /// every block (observed spread ~4%); a tx priced below the base fee at
  /// submission is rejected ("max fee per gas less than block base fee").
  /// The chain charges the inclusion block's base fee, not the signed price,
  /// so headroom is a ceiling rather than a payment. +20% covers the observed
  /// intra-second swings with a wide margin.
  GAS_PRICE_HEADROOM_BPS: 2000,
  /// If the cap leaves less headroom than this, do not sign (retry next tick).
  GAS_PRICE_MIN_HEADROOM_BPS: 500,
  /// Absolute ceiling for any signed gasPrice: 1 gwei (~15x the observed ~0.067 gwei base fee).
  MAX_GAS_PRICE_WEI: 1_000_000_000n,
  /// Permit2 pre-flight (positions/permit2Preflight.ts): a grant expiring within
  /// this window is still usable but logged as a warning so the operator can
  /// renew it deliberately (never renewed automatically).
  PERMIT2_EXPIRY_WARNING_SECONDS: 7 * 24 * 60 * 60,
  /// A grant must stay valid at least this long past the pre-flight to be used:
  /// one OPENING lifetime (OPENING_MAX_AGE_MS), the longest a reserved entry may
  /// still reach its mint. Anything shorter could expire between reservation and mint.
  PERMIT2_MIN_REMAINING_VALIDITY_SECONDS: DISCOVERY.CYCLE_INTERVAL_MS / 1000,
  /// OPERATOR-AUTHORISED Permit2 renewal (positions/permit2Renewal.ts). Nothing
  /// here is ever applied automatically: these only bound what an operator may
  /// ask for. See docs/permit2-renewal-design.md.
  PERMIT2_RENEWAL: {
    /// The lifetime a renewal grants, measured from CHAIN time. 90 days: long
    /// enough that renewal is a rare, deliberate act; short enough that an
    /// abandoned key's standing authorisation to move USDG dies on its own.
    /// Configurable rather than hard-coded, but bounded by MAX_LIFETIME_SECONDS.
    DEFAULT_LIFETIME_SECONDS: 90 * 24 * 60 * 60,
    /// Hard ceiling on any requested lifetime. `type(uint48).max` (a grant that
    /// never expires) is deliberately unreachable: it would remove the only
    /// time-bound on a standing permission to move USDG.
    MAX_LIFETIME_SECONDS: 180 * 24 * 60 * 60,
    /// A renewal is only *eligible* once the grant is at least this close to
    /// expiry, so an operator cannot keep pushing the expiry out indefinitely
    /// (each renewal is a real transaction and a real extension of authority).
    ELIGIBLE_WHEN_REMAINING_SECONDS: 30 * 24 * 60 * 60,
    /// Renewal is *recommended* from here on -- same 7 days the entry pre-flight
    /// already warns at, so the two never disagree.
    RECOMMEND_WHEN_REMAINING_SECONDS: 7 * 24 * 60 * 60,
    /// A renewal must leave the grant meaningfully longer than it already is,
    /// otherwise it is a no-op that spends gas for nothing.
    MIN_IMPROVEMENT_SECONDS: 24 * 60 * 60,
    /// uint48 max -- the value the implementation must REFUSE, kept named so the
    /// refusal is explicit rather than an unexplained magic number.
    FORBIDDEN_EXPIRATION: 2 ** 48 - 1,
  },
} as const;

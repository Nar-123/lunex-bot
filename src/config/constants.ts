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
} as const;

// ---------------------------------------------------------------------------
// 5. Capital Management
// ---------------------------------------------------------------------------
export const CAPITAL = {
  // Position size = 35% of FREE/AVAILABLE USDG balance at deployment time
  // (not 35% of the original/starting balance).
  POSITION_SIZE_PCT_OF_FREE_BALANCE: 0.35,
  MAX_ACTIVE_POSITIONS: 3,
  MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO: 0.9, // hard cap
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
 *   1. HARD_STOP_LOSS      PnL <= -6%
 *   2. SAFETY_EXIT         armed at max-drawdown <= -8%, closes on recovery to >= 0%
 *   3. OVEREXTENDED        Bollinger %B >= 1.0 AND PnL > 0
 *   4. TRAILING_TP         arm at +6%, close on -3pp from peak, 15s confirm
 *   5. HARD_TAKE_PROFIT    PnL >= +25%
 *   6. OOR_PROFIT          out of range AND PnL >= +2%
 *   7. LOW_YIELD           age >= 30min AND fee yield below floor
 *   8. OOR_TIMEOUT / INFRA_SAFETY_EXIT  (pre-existing Lunex protections)
 */
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
   * Note the interaction with Priority 1: with the stop at -6% and this
   * arming at -8%, any PnL reading that arms this rule is also at or below
   * the stop on that SAME tick, and the stop wins (Priority 1). A price gap
   * between polls does not change that: max drawdown only moves on an
   * actual PnL reading, and that reading is the one the stop evaluates.
   * Under the shipped defaults this rule therefore only produces a close
   * when (a) the stop is live-widened past -8% via
   * `BotSettings.hardStopLossPct`, or (b) a stop-triggered exit failed
   * definitively and reverted the position to ACTIVE (`executeExit.ts`),
   * and the next PnL reading has already recovered to the target. That is
   * Meridian's own arrangement, kept deliberately -- documentation only,
   * no behaviour is implied or changed by this note.
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
  SWAP_RETRY: {
    STUCK_THRESHOLD: 3, // = SLIPPAGE_TIERS_BPS.length: all tiers spent
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
} as const;

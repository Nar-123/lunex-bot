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
 * check (`EXITS.IMPACT_CHECK_ENABLED`, currently OFF) if that's ever
 * re-enabled. Never define a second threshold elsewhere — both call
 * sites must read this constant.
 */
export const PRICE_IMPACT = {
  MAX_EXIT_IMPACT_PCT: 0.01, // 1%
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
export const EXITS = {
  TRAILING_TP: {
    TRIGGER_PEAK_PNL_PCT: 0.05, // trailing TP arms once peak PNL reaches +5%
    DRAWDOWN_FROM_PEAK_PCT: 0.02, // dynamic drawdown from the highest peak seen
    CONFIRM_WINDOW_MS: 15 * 1000, // confirmation timer once drawdown is breached
  },
  HARD_STOP_LOSS_PCT: -0.15, // from entry
  PNL_PROTECTION: {
    TRIGGER_PNL_PCT: -0.08, // if PNL <= -8%
    NEW_TP_TARGET_PCT: 0, // ...retarget TP to breakeven (0%)
  },
  OOR: {
    GRACE_WINDOW_MS: 30 * 60 * 1000, // 30 minutes out-of-range before closing
  },
  // Explicitly OFF — do not implement as an exit trigger.
  LOW_YIELD_EXIT_ENABLED: false,
  SAFETY_EXIT_ENABLED: true, // handles abnormal conditions (RPC outage, contract behavior change, etc.)

  /**
   * Concrete, testable Safety Exit conditions (Module 8) — deliberately
   * NOT an empty/never-triggered category. Two conditions:
   *  (a) this position's live metrics have failed to read successfully,
   *      continuously, for longer than MAX_METRICS_FAILURE_MS (persisted
   *      via ExitState.metricsFailureSince, since a restart must not reset
   *      the streak to zero);
   *  (b) a pool price read that's structurally impossible to trust
   *      (sqrtPriceX96 <= 0 or tickCurrent outside TickMath's valid range)
   *      — triggers immediately, no timer, since the data itself can't be
   *      used to compute anything meaningful.
   * See exits/safetyExit.ts.
   */
  SAFETY_EXIT: {
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
  SWAP_RETRY: {
    STUCK_THRESHOLD: 5, // matches EXECUTION.STUCK_ATTEMPT_MAX_RETRIES for consistency
  },

  /**
   * OFF by default per spec. Price impact is still computed and logged for
   * every exit swap regardless of this flag; when enabled, execution must
   * compare it against `PRICE_IMPACT.MAX_EXIT_IMPACT_PCT` — the exact same
   * constant `pools/selectPool.ts` already enforces at pool-selection time.
   * Never introduce a second threshold here. Keep this a single config
   * read so it can be flipped without touching swap/exit execution code.
   */
  IMPACT_CHECK_ENABLED: env.EXIT_IMPACT_CHECK_ENABLED, // default false

  /**
   * OFF by default per spec. When disabled, exit swaps do not set an
   * amountOutMinimum / minimum-received guard. When enabled, execution
   * should compute and apply a slippage-based minimum received.
   */
  MIN_RECEIVED_PROTECTION_ENABLED: env.EXIT_MIN_RECEIVED_PROTECTION_ENABLED, // default false
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
} as const;

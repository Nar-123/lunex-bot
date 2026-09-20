import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * `z.coerce.boolean()` is a footgun for env vars -- it coerces via plain
 * `Boolean(value)`, which means the STRING "false" (any non-empty string)
 * becomes `true`. Found via Module 10's real-Prisma smoke test:
 * `API_TRUST_PROXY=false` in `.env.example` was silently read as `true`,
 * which in turn made `express-rate-limit` refuse to start at all (it
 * detects an overly-permissive trust-proxy setting and throws
 * `ERR_ERL_PERMISSIVE_TRUST_PROXY`) -- this bug was latent in every
 * `z.coerce.boolean()` field below (all default OFF, all silently flipped
 * ON by the literal string "false") until something finally read one of
 * them at runtime. Parses "true"/"false" literally; anything else fails
 * validation instead of silently guessing, same fail-fast discipline as
 * the rest of this file.
 */
function booleanEnv(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .refine((v) => v === undefined || v === 'true' || v === 'false', { message: 'must be "true" or "false"' })
    .transform((v) => (v === undefined ? defaultValue : v === 'true'));
}

/**
 * Shared by `envSchema`'s `superRefine` (validates) AND `config/index.ts`'s
 * `telegram.authorizedUserIds` derivation (uses the parsed result) -- ONE
 * implementation of "how a comma-separated Telegram user-id list is
 * tokenized and checked," so the validator and the deriver structurally
 * cannot diverge. `ids` contains only the entries that already passed the
 * `^\d+$` check; `invalidEntries` contains the rest, verbatim (trimmed),
 * for the validator's error message. Empty segments from stray/double
 * commas and surrounding whitespace are silently tolerated (trimmed away
 * before either check) -- only a genuinely non-numeric token counts as
 * invalid.
 */
export function parseTelegramUserIds(raw: string): { ids: number[]; invalidEntries: string[] } {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const invalidEntries = entries.filter((e) => !/^\d+$/.test(e));
  const ids = entries.filter((e) => /^\d+$/.test(e)).map(Number);
  return { ids, invalidEntries };
}

/**
 * All environment-sourced configuration is validated here, once, at process
 * start. Anything that fails validation throws immediately (fail fast) —
 * a bot that manages real funds must never run with a silently-wrong config.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Blockchain / RPC
  RPC_URL: z.url(),
  RPC_FALLBACK_URLS: z.string().default(''),
  CHAIN_ID: z.coerce.number().int().positive(),
  PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'PRIVATE_KEY must be a 0x-prefixed 32-byte hex string'),

  // Token / protocol addresses
  USDG_TOKEN_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /**
   * Phase 12G fix: the real on-chain USDG contract on Robinhood Chain
   * (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`) returns `decimals() = 6`
   * (verified directly via `eth_call`, selector `0x313ce567` -- see Phase
   * 12F/12G). The default here was previously `18` (a plausible-looking but
   * WRONG guess -- USDG is not an 18-decimal token like most ERC20s), which
   * every USDG-decimals-sensitive code path (`config/constants.ts`'s
   * `QUOTE_ASSET.DECIMALS`) trusted verbatim. `index.ts`'s startup sequence
   * additionally calls `blockchain/erc20.ts`'s
   * `assertQuoteAssetDecimalsMatchOnChain` to fail fast if this value is
   * ever wrong again (a redeployed/migrated USDG, a copy-paste `.env`
   * mistake) rather than silently trusting a static number forever.
   */
  USDG_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),

  UNISWAP_V2_FACTORY_ADDRESS: z.string().optional().default(''),
  UNISWAP_V2_ROUTER_ADDRESS: z.string().optional().default(''),
  UNISWAP_V3_FACTORY_ADDRESS: z.string().optional().default(''),
  UNISWAP_V3_QUOTER_ADDRESS: z.string().optional().default(''),
  UNISWAP_V3_SWAP_ROUTER_ADDRESS: z.string().optional().default(''),
  UNISWAP_V3_NFT_POSITION_MANAGER_ADDRESS: z.string().optional().default(''),
  // Real Robinhood Chain deployment addresses (confirmed, not guessed).
  // `pools/poolStateProvider.ts` additionally self-checks at runtime that
  // the configured StateView is actually bound to this PoolManager via
  // `StateView.poolManager()`, so a copy/paste mismatch between these two
  // still fails loudly instead of silently reading the wrong state.
  UNISWAP_V4_POOL_MANAGER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default('0x8366a39cc670b4001a1121b8f6a443a643e40951'),
  // Lower bound for on-chain Initialize/Swap log scans (pools/ pool
  // discovery + volume estimation). VERIFIED public fact (Phase 5): the
  // PoolManager's creation tx
  // 0x4fb28d4935866f462582c6c931c6f2705e55f5be5eb178c7d8d9329a95c44c41 was
  // mined in block 9070 (2026-05-22), confirmed against both the robinscan
  // index and a live node's eth_getTransactionByHash (see README's LIVE
  // VALIDATION CHECKLIST for the full evidence). Still overridable for a
  // different deployment/fork.
  UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK: z.coerce.bigint().default(9070n),
  UNISWAP_V4_QUOTER_ADDRESS: z.string().optional().default(''),
  // Real Robinhood Chain deployment address (confirmed, not guessed --
  // same "confirmed real address" status as UNISWAP_V4_POOL_MANAGER_ADDRESS/
  // UNISWAP_V4_STATE_VIEW_ADDRESS above, closing the gap flagged in Module
  // 9A's README section). `positions/mintTx.ts` self-checks at runtime
  // that this is actually bound to the configured PoolManager (via
  // PositionManager.poolManager()), same pattern as
  // pools/poolStateProvider.ts's StateView check.
  UNISWAP_V4_POSITION_MANAGER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default('0x58daec3116aae6d93017baaea7749052e8a04fa7'),
  // H5 (reconciliation): lower bound for the PositionManager ERC721
  // Transfer-log scan used to enumerate every NFT the wallet currently
  // owns (orphan-NFT detection). VERIFIED public fact (Phase 5): the
  // PositionManager's creation tx
  // 0x228c18ada6cb46b4fbcc18f4ec1519953415393e256fa8349aafbd5a2db037c8 was
  // mined in block 9073 (2026-05-22), create2 createdContract = the
  // configured address -- cross-checked the same way as the PoolManager's
  // deploy block above.
  UNISWAP_V4_POSITION_MANAGER_DEPLOY_BLOCK: z.coerce.bigint().default(9073n),
  // Uniswap Permit2 (canonical CREATE2 address, identical on every chain).
  // The v4 PositionManager settles a mint's token debt through
  // `permit2.transferFrom` -- VERIFIED on the first live mint (trace:
  // PositionManager -> Permit2 -> USDG.transferFrom -> PoolManager) and via
  // the on-chain `PositionManager.permit2()` getter, which
  // positions/permit2Preflight.ts cross-checks against this value.
  PERMIT2_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default('0x000000000022D473030F116dDEE9F6B43aC78BA3'),
  UNISWAP_V4_STATE_VIEW_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'),
  UNISWAPX_REACTOR_ADDRESS: z.string().optional().default(''),

  // Uniswap Trading API — used ONLY for exits/'s TOKEN->USDG swap quote +
  // calldata (Module 8). Chosen over GMGN specifically because GMGN cannot
  // swap directly to a stablecoin (ETH-only exits), which would turn the
  // two-transaction exit flow into three. The API returns UNSIGNED calldata
  // only — Lunex always signs/broadcasts it itself through
  // executeCriticalTransaction (Module 6), never delegates signing. Base
  // URL is unconfirmed/unverified from here (no network access to check
  // real API docs) — flagged the same way GMGN_BASE_URL was: a sensible
  // placeholder, not a guess presented as fact, and callers must treat the
  // exact endpoint/JSON shape as best-effort until checked against the
  // real service (see swap/tradingApiMapper.ts).
  // C5 fix: was `.optional().default('')` -- the Trading API is a
  // MANDATORY dependency of the exit flow (every position close needs a
  // TOKEN->USDG swap quote), not an opt-in feature like Telegram. Starting
  // successfully with an empty key silently deferred the failure to the
  // first real exit attempt (a 401 at the worst possible moment: AFTER
  // liquidity has already been removed). Required now, same pattern as
  // every other mandatory secret in this file (PRIVATE_KEY, RPC_URL, etc.).
  UNISWAP_API_KEY: z.string().min(1, 'UNISWAP_API_KEY is required -- the Trading API is a mandatory dependency of the exit flow'),
  // H9 fix: the ONLY contract address the exit swap's calldata is allowed
  // to target (Universal Router or whatever real router the Trading API
  // actually returns calldata for on Robinhood Chain) -- validateSwapQuote.ts
  // rejects EVERY swap outright when this is empty, per explicit review:
  // "if the official router address isn't confirmed, FAIL CLOSED," never
  // fall back to accepting an arbitrary well-formed-looking address. Left
  // unset (empty) by default deliberately -- this project has not
  // confirmed Robinhood Chain's real router address from here, and a
  // placeholder guess would be worse than refusing to swap at all.
  UNISWAP_ALLOWED_SWAP_ROUTER_ADDRESS: z.string().optional().default(''),
  // Chain-scoped execution-target allowlists (comma-separated), applied to the
  // ACTIVE chain. Either one, when set, REPLACES that chain's audited default
  // list in constants.ts EXECUTION_TARGETS; unset means use the audited
  // defaults. An approved Universal Router may be a direct swap target and is
  // the only kind of address a SwapProxy payload may name -- see
  // swap/executionTargets.ts for why both layers are checked.
  UNISWAP_ALLOWED_UNIVERSAL_ROUTERS: z.string().optional().default(''),
  UNISWAP_ALLOWED_SWAP_PROXIES: z.string().optional().default(''),
  // C5 fix: was an internal/undocumented interface-gateway host. This is
  // the real, documented public endpoint -- confirmed by fetching the live
  // OpenAPI spec at https://trade-api.gateway.uniswap.org/v1/api.json
  // directly (not assumed). README.md already stated this correct URL,
  // inconsistently with this file's old default.
  UNISWAP_TRADING_API_BASE_URL: z.string().optional().default('https://trade-api.gateway.uniswap.org'),

  // GMGN — accessed via the `gmgn-cli` tool (child process), not a direct
  // HTTP call. GMGN_BASE_URL is kept only in case a future CLI build
  // supports an explicit API host override; it is not currently passed
  // to the CLI (see discovery/gmgnCliClient.ts).
  GMGN_CLI_PATH: z.string().min(1).default('gmgn-cli'),
  GMGN_BASE_URL: z.string().optional().default(''),
  GMGN_API_KEY: z.string().optional().default(''),

  // Database
  DATABASE_PROVIDER: z.enum(['sqlite', 'postgresql']).default('sqlite'),
  DATABASE_URL: z.string().min(1),

  // API
  API_PORT: z.coerce.number().int().positive().default(8443),
  API_HOST: z.string().default('0.0.0.0'),
  API_HTTPS_CERT_PATH: z.string().optional().default(''),
  API_HTTPS_KEY_PATH: z.string().optional().default(''),
  API_TRUST_PROXY: booleanEnv(false),
  API_CORS_ORIGIN: z.string().optional().default(''),

  // Composition root / process lifecycle (Module 9B)
  // How long `stop()` (composition/app.ts) waits, on SIGTERM/SIGINT, for
  // an in-flight cycle to finish on its own before giving up on WAITING
  // for it -- this timeout never cancels the in-flight work itself (see
  // composition/app.ts's doc comment on `stop()`: there is no
  // AbortController anywhere in this pipeline, so a DB write or an
  // `executeCriticalTransaction` call already in flight always runs to
  // completion regardless of this value). Default is deliberately
  // generous: comfortably longer than any single critical step should
  // normally take (a transaction's wait-for-receipt, a handful of RPC
  // calls, a full mint) -- explicitly NOT sized to the 30-minute
  // screening SCHEDULE interval itself (how often a new cycle STARTS is a
  // different concern from how long one instance normally takes to
  // finish). Tunable per deployment, never hardcoded at the call site.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000), // 10 minutes

  // Auth
  AUTH_ADMIN_USERNAME: z.string().min(1),
  AUTH_ADMIN_PASSWORD_HASH: z.string().min(1),
  // Module 11: the ONLY consumer of this is telegram/'s own bot-to-API
  // login (POST /auth/login) -- a same-host, unattended, already-trusted
  // process has no human to prompt for a password at boot, so a plaintext
  // credential has to live SOMEWHERE. Deliberately reuses the human
  // admin's own credential rather than a separate service token/API key
  // -- see README's Module 11 section for the explicit reasoning (raised
  // and considered in review, not overlooked). Required (enforced below,
  // via superRefine) whenever TELEGRAM_BOT_TOKEN is set -- an operator who
  // enables Telegram but forgets this must be refused at startup, not
  // left with a bot that retries a doomed login forever (see
  // `telegram/apiClient.ts`'s `loginWithRetry`, which is deliberately
  // unbounded and therefore CANNOT be the thing that catches this).
  // Must be kept in sync with AUTH_ADMIN_PASSWORD_HASH by the operator --
  // no automatic cross-check is possible (bcrypt is one-way); a mismatch
  // surfaces loudly as a failed bot login at startup instead.
  AUTH_ADMIN_PASSWORD: z.string().optional().default(''),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRY: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRY: z.string().default('7d'),
  LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // Telegram
  // Well-known Telegram bot-token shape (<bot_id>:<35-char secret>).
  // Validated only when non-empty -- Telegram remains an optional
  // integration (empty token = disabled, see src/index.ts).
  TELEGRAM_BOT_TOKEN: z
    .string()
    .optional()
    .default('')
    .refine((v) => v === '' || /^\d+:[A-Za-z0-9_-]{35}$/.test(v), {
      message: 'TELEGRAM_BOT_TOKEN must match <bot_id>:<35-char-secret>, or be empty to disable Telegram',
    }),
  TELEGRAM_BOT_NAME: z.string().default('Lunex Bot'),
  // Comma-separated positive-integer Telegram user ids. Validated below
  // (superRefine, via `parseTelegramUserIds` -- the SAME function
  // `config/index.ts` calls to actually derive `authorizedUserIds:
  // number[]`, so the two can never silently diverge) so a malformed
  // entry (typo, stray letter) fails startup loudly instead of silently
  // becoming `NaN` in `config.telegram.authorizedUserIds`.
  TELEGRAM_AUTHORIZED_USER_IDS: z.string().optional().default(''),

  // Capital management — unlocked/TBD
  ETH_GAS_RESERVE_ENABLED: booleanEnv(false),
  ETH_GAS_RESERVE_MIN: z.coerce.number().min(0).default(0),

  // Phase 10A: canary mode — a dedicated, disabled-by-default position-size
  // cap for the FIRST live transaction, entirely separate from CAPITAL's
  // 35% production default. The two numeric caps are deliberately left
  // `.optional()` with NO default value -- an invented "safe-looking"
  // number here would be exactly the kind of unapproved capital-allocation
  // change this feature exists to prevent. They stay unset until an
  // operator explicitly configures at least one (enforced below).
  CANARY_ENABLED: booleanEnv(false),
  CANARY_MAX_POSITION_PCT: z.coerce.number().gt(0).max(1).optional(),
  CANARY_MAX_USDG: z.coerce.number().positive().optional(),

  // TIER 3 (Meridian alignment): the exit price-impact gate is now ON by
  // default -- Meridian's measured `maxExitPriceImpactPct: 0.5` is the
  // single filter its own strategy doc credits with working against a
  // round-trip cost 3.1x larger than the pool-level edge. Still
  // overridable, but the safe default is now "check it."
  EXIT_IMPACT_CHECK_ENABLED: booleanEnv(true),
  EXIT_MIN_RECEIVED_PROTECTION_ENABLED: booleanEnv(false),
}).superRefine((data, ctx) => {
  if (data.TELEGRAM_BOT_TOKEN !== '' && data.AUTH_ADMIN_PASSWORD === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_ADMIN_PASSWORD'],
      message:
        'AUTH_ADMIN_PASSWORD wajib diisi kalau TELEGRAM_BOT_TOKEN diaktifkan -- dibutuhkan oleh ' +
        "telegram/'s bot-to-API login (POST /auth/login). Without it, the bot would retry a login " +
        'that can never succeed, forever, with no clear startup failure.',
    });
  }

  const { invalidEntries } = parseTelegramUserIds(data.TELEGRAM_AUTHORIZED_USER_IDS);
  if (invalidEntries.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['TELEGRAM_AUTHORIZED_USER_IDS'],
      message:
        `TELEGRAM_AUTHORIZED_USER_IDS contains non-numeric entr${invalidEntries.length === 1 ? 'y' : 'ies'}: ` +
        `${invalidEntries.map((e) => `"${e}"`).join(', ')} -- must be a comma-separated list of positive integer ` +
        'Telegram user ids (whitespace around entries and empty segments from stray commas are tolerated; ' +
        'anything else is rejected rather than silently dropped or parsed as NaN).',
    });
  }

  // Phase 10A: an operator who sets CANARY_ENABLED=true without configuring
  // EITHER numeric cap would otherwise silently get the full 35% production
  // size on the very first live transaction -- exactly the outcome canary
  // mode exists to prevent. Fail startup loudly instead.
  if (data.CANARY_ENABLED && data.CANARY_MAX_POSITION_PCT === undefined && data.CANARY_MAX_USDG === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['CANARY_ENABLED'],
      message:
        'CANARY_ENABLED=true requires at least one of CANARY_MAX_POSITION_PCT or CANARY_MAX_USDG to be set -- ' +
        'an operator-defined cap, never invented by the code. Set one (or both) before enabling canary mode.',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * Exported for `tests/config/envBooleans.test.ts` -- a generic regression
 * test that discovers every boolean-typed field on this schema itself
 * (not a hardcoded name list) and proves the "false"/"true" STRING
 * literals parse correctly for each one, and that a bare `z.coerce.boolean()`
 * regression (accepting e.g. "yes" as truthy) would be caught. Not used
 * anywhere else -- `env`/`loadEnv()` below remain the only real parse path.
 */
export { envSchema };

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();

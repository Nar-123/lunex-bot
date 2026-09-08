import { env, parseTelegramUserIds } from './env';
import * as constants from './constants';
import type {
  ChainConfig,
  UniswapAddressBook,
  GmgnConfig,
  UniswapTradingApiConfig,
  DatabaseConfig,
  ApiConfig,
  AuthConfig,
  TelegramConfig,
  CompositionConfig,
} from './types';

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const chain: ChainConfig = {
  chainId: env.CHAIN_ID,
  rpcUrl: env.RPC_URL,
  rpcFallbackUrls: splitCsv(env.RPC_FALLBACK_URLS),
};

const uniswap: UniswapAddressBook = {
  v2: {
    factory: env.UNISWAP_V2_FACTORY_ADDRESS,
    router: env.UNISWAP_V2_ROUTER_ADDRESS,
  },
  v3: {
    factory: env.UNISWAP_V3_FACTORY_ADDRESS,
    quoter: env.UNISWAP_V3_QUOTER_ADDRESS,
    swapRouter: env.UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    nftPositionManager: env.UNISWAP_V3_NFT_POSITION_MANAGER_ADDRESS,
  },
  v4: {
    poolManager: env.UNISWAP_V4_POOL_MANAGER_ADDRESS,
    poolManagerDeployBlock: env.UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK,
    quoter: env.UNISWAP_V4_QUOTER_ADDRESS,
    positionManager: env.UNISWAP_V4_POSITION_MANAGER_ADDRESS,
    stateView: env.UNISWAP_V4_STATE_VIEW_ADDRESS,
  },
  uniswapX: {
    reactor: env.UNISWAPX_REACTOR_ADDRESS,
  },
};

const gmgn: GmgnConfig = {
  cliPath: env.GMGN_CLI_PATH,
  baseUrl: env.GMGN_BASE_URL,
  apiKey: env.GMGN_API_KEY,
};

const uniswapTradingApi: UniswapTradingApiConfig = {
  baseUrl: env.UNISWAP_TRADING_API_BASE_URL,
  apiKey: env.UNISWAP_API_KEY,
};

const database: DatabaseConfig = {
  provider: env.DATABASE_PROVIDER,
  url: env.DATABASE_URL,
};

const api: ApiConfig = {
  port: env.API_PORT,
  host: env.API_HOST,
  httpsCertPath: env.API_HTTPS_CERT_PATH,
  httpsKeyPath: env.API_HTTPS_KEY_PATH,
  trustProxy: env.API_TRUST_PROXY,
  corsOrigin: env.API_CORS_ORIGIN,
};

const auth: AuthConfig = {
  adminUsername: env.AUTH_ADMIN_USERNAME,
  adminPasswordHash: env.AUTH_ADMIN_PASSWORD_HASH,
  adminPassword: env.AUTH_ADMIN_PASSWORD,
  jwtSecret: env.JWT_SECRET,
  jwtExpiry: env.JWT_EXPIRY,
  refreshTokenExpiry: env.REFRESH_TOKEN_EXPIRY,
  loginRateLimitWindowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS,
  loginRateLimitMaxAttempts: env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
};

const composition: CompositionConfig = {
  shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
};

const telegram: TelegramConfig = {
  botToken: env.TELEGRAM_BOT_TOKEN,
  botName: env.TELEGRAM_BOT_NAME,
  // Safe to trust unconditionally here -- envSchema's superRefine has
  // ALREADY guaranteed every entry is a clean non-negative integer string
  // by the time this runs (zod validation happens at module load, before
  // this file's top-level code executes) -- `invalidEntries` would only
  // ever be non-empty if `env` itself had already thrown during
  // `loadEnv()`, in which case this line never executes at all.
  authorizedUserIds: parseTelegramUserIds(env.TELEGRAM_AUTHORIZED_USER_IDS).ids,
};

/**
 * Single, typed configuration object for the entire application.
 * Business-logic constants (spec-locked numbers) live under `rules`;
 * environment/deployment-specific values live under their own namespaces.
 */
export const config = {
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  chain,
  executorPrivateKey: env.PRIVATE_KEY,
  quoteAsset: constants.QUOTE_ASSET,
  uniswap,
  gmgn,
  uniswapTradingApi,
  database,
  api,
  auth,
  telegram,
  composition,
  rules: {
    discovery: constants.DISCOVERY,
    filters: constants.FILTERS,
    poolSelection: constants.POOL_SELECTION,
    priceImpact: constants.PRICE_IMPACT,
    lpStrategy: constants.LP_STRATEGY,
    capital: constants.CAPITAL,
    cycle: constants.CYCLE,
    monitoring: constants.MONITORING,
    exits: constants.EXITS,
    exitFlowSteps: constants.EXIT_FLOW_STEPS,
    txSafetySteps: constants.TX_SAFETY_STEPS,
    txSafety: constants.TX_SAFETY,
    cooldown: constants.COOLDOWN,
    interfaces: constants.INTERFACES,
    execution: constants.EXECUTION,
  },
} as const;

export type AppConfig = typeof config;

export * from './types';
export { env } from './env';
export * as constants from './constants';

/** Shared config-shaped types, consumed by config/index.ts and downstream modules. */

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  rpcFallbackUrls: string[];
}

export interface UniswapAddressBook {
  v2: {
    factory: string;
    router: string;
  };
  v3: {
    factory: string;
    quoter: string;
    swapRouter: string;
    nftPositionManager: string;
  };
  v4: {
    poolManager: string;
    /** Block the PoolManager was deployed at — lower bound for `Initialize`/`Swap` log scans. */
    poolManagerDeployBlock: bigint;
    quoter: string;
    positionManager: string;
    /** Periphery StateView contract — the standard way to read v4 pool state (slot0/liquidity/ticks) off-chain. */
    stateView: string;
  };
  uniswapX: {
    reactor: string;
  };
}

export interface QuoteAssetConfig {
  symbol: string;
  address: string;
  decimals: number;
}

export interface GmgnConfig {
  cliPath: string;
  baseUrl: string;
  apiKey: string;
}

/** Uniswap Trading API — exits/'s TOKEN->USDG swap quote+calldata source (Module 8). See env.ts's UNISWAP_API_KEY comment for why this replaced GMGN for this one call site. */
export interface UniswapTradingApiConfig {
  baseUrl: string;
  apiKey: string;
}

export interface DatabaseConfig {
  provider: 'sqlite' | 'postgresql';
  url: string;
}

export interface ApiConfig {
  port: number;
  host: string;
  httpsCertPath: string;
  httpsKeyPath: string;
  trustProxy: boolean;
  corsOrigin: string;
}

export interface AuthConfig {
  adminUsername: string;
  adminPasswordHash: string;
  /** Plaintext -- Module 11's telegram/ bot-to-API login only. See config/env.ts's AUTH_ADMIN_PASSWORD doc comment. */
  adminPassword: string;
  jwtSecret: string;
  jwtExpiry: string;
  refreshTokenExpiry: string;
  loginRateLimitWindowMs: number;
  loginRateLimitMaxAttempts: number;
}

export interface TelegramConfig {
  botToken: string;
  botName: string;
  authorizedUserIds: number[];
}

/** Composition-root/process-lifecycle settings (Module 9B) -- deployment-tunable, not a locked spec business rule, so it lives alongside `api`/`auth` rather than under `rules`. */
export interface CompositionConfig {
  shutdownTimeoutMs: number;
}

export type FeeTierKey = 'LOW' | 'MID' | 'HIGH';

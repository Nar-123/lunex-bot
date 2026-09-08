/**
 * Vitest global setup — populates process.env with fixed, obviously-fake
 * values BEFORE any test imports `src/config`, since env.ts validates and
 * freezes `env` at module-import time. This keeps unit tests (filters,
 * strategies, capital math, etc.) independent of a real `.env` file while
 * still exercising the real validated config shape.
 *
 * None of these values are secrets — they are non-functional placeholders
 * (fake RPC URL, fake key, fake hash) that satisfy zod's shape/format
 * checks only. Never reuse them outside tests.
 */
const testEnv: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  RPC_URL: 'https://test-rpc.invalid',
  CHAIN_ID: '4663', // Robinhood Chain — must match a real entry in GMGN_CHAIN_SLUGS
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  USDG_TOKEN_ADDRESS: '0x' + '22'.repeat(20),
  USDG_DECIMALS: '18',
  // Unset by default (env.ts's own default is ''), which breaks any code
  // path that actually encodes calldata against it (e.g.
  // positions/approveTx.ts's fixed USDG->PositionManager approve) --
  // Module 9's openPosition.ts is the first consumer to need a real,
  // valid-shaped value here for its tests to run at all.
  UNISWAP_V4_POSITION_MANAGER_ADDRESS: '0x' + '33'.repeat(20),
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: 'file:./data/test.db',
  AUTH_ADMIN_USERNAME: 'test-admin',
  AUTH_ADMIN_PASSWORD_HASH: '$2b$12$' + 'a'.repeat(53),
  JWT_SECRET: 'test-jwt-secret-not-for-real-use',
};

for (const [key, value] of Object.entries(testEnv)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

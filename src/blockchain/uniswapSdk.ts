import { createRequire } from 'node:module';

const requireCjs = createRequire(__filename);

/**
 * `@uniswap/v4-sdk` is required here via Node's CJS `createRequire` rather
 * than a static `import`, per explicit review guidance for this project.
 *
 * Note for future maintainers: this project compiles to CommonJS
 * (`tsconfig.json` -> `"module": "commonjs"`, and `package.json` has no
 * `"type": "module"`), so a plain `import ... from '@uniswap/v4-sdk'`
 * already lowers to a `require(...)` call at build time — it does not go
 * through Node's native ESM resolver, so it would not actually hit the
 * ESM "directory import" failure mode this package is known to trigger in
 * a pure-ESM project. `createRequire` is kept anyway as explicit,
 * version-proof insurance: it's harmless under our current CJS setup and
 * protects against a future ESM migration or a package.json `exports`-map
 * regression (verified against the installed version: it currently ships
 * a clean `exports.require` pointing at a concrete `dist/cjs/src/index.js`
 * file, not a directory).
 *
 * Lunex uses Uniswap v4 for all AMM/trading logic — `@uniswap/v3-sdk`'s
 * `Pool`/`Position`/`Route`/`Trade`/fee-tier machinery is never imported or
 * called directly anywhere in this codebase; that's what "v4 ONLY" means.
 */
export const v4Sdk = requireCjs('@uniswap/v4-sdk') as typeof import('@uniswap/v4-sdk');

/**
 * SCOPE NOTE (added for `strategies/`, re-narrowing the "v4 ONLY" claim
 * above so it doesn't overstate things): `nearestUsableTick`,
 * `TickMath` (incl. `MIN_TICK`/`MAX_TICK`), and `encodeSqrtRatioX96` are
 * pure tick-arithmetic utilities, not v3 AMM/trading logic — and they are
 * NOT reimplemented or re-exported by `@uniswap/v4-sdk`'s public API
 * (verified: v4-sdk's own `tickToPrice`/`priceToClosestTick` and its
 * `Pool` class import these exact three functions from `@uniswap/v3-sdk`
 * internally to do v4's own tick math). There is no v4-native alternative
 * to reach for here. Re-implementing tick-spacing rounding or the
 * sqrtPrice<->tick conversion ourselves instead of using these would be
 * strictly worse (more bug surface, duplicating logic the SDK ecosystem
 * already tested) — so `strategies/` imports exactly these three
 * functions, and nothing else from v3-sdk (no `Pool`, no `FeeAmount`, no
 * `TICK_SPACINGS`).
 */
const v3TickMathSdk = requireCjs('@uniswap/v3-sdk') as typeof import('@uniswap/v3-sdk');
export const v3TickMathUtils = {
  TickMath: v3TickMathSdk.TickMath,
  nearestUsableTick: v3TickMathSdk.nearestUsableTick,
  encodeSqrtRatioX96: v3TickMathSdk.encodeSqrtRatioX96,
};

/**
 * Verified findings (checked against the installed `@uniswap/v4-sdk`
 * version) that directly affect `pools/`:
 *
 * 1. NO fee-keyed tick-spacing patch is needed for v4 (unlike v3's
 *    `TICK_SPACINGS[fee]` lookup table, which is why an earlier version
 *    of this project carried a `registerV3TickSpacing` patch mechanism —
 *    removed, since Lunex never constructs a v3 `Pool` directly). v4's
 *    `Pool` constructor takes `tickSpacing` as an explicit argument
 *    (`new Pool(currencyA, currencyB, fee, tickSpacing, hooks, ...)`) and
 *    stores it directly — it is never derived from `fee` via a fixed map.
 *    This matches v4's on-chain design: `tickSpacing` is part of the
 *    `PoolKey` struct itself, set explicitly whenever a pool is
 *    initialized, for exactly this reason (arbitrary fee tiers).
 *
 * 2. `Pool.getOutputAmount()` / `Pool.getInputAmount()` (used by
 *    `pools/priceImpact.ts` to simulate an exit swap against the pool's
 *    real liquidity distribution) throw `Error('Unsupported hook')` for
 *    any pool whose hook contract has swap-affecting permissions
 *    (`Hook.hasSwapPermissions`). Lunex cannot locally simulate a swap
 *    for such a pool with this SDK method — `pools/priceImpact.ts`
 *    treats that as "price impact could not be verified" and rejects the
 *    pool conservatively, rather than assuming it's safe or falling back
 *    to a cruder estimate.
 */

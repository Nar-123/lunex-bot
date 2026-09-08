import { Token } from '@uniswap/sdk-core';
import { v3TickMathUtils, v4Sdk } from '../../src/blockchain/uniswapSdk';
import type { PositionRecord } from '../../src/positions/types';
import type { LivePositionState, PoolPriceState } from '../../src/monitoring/types';

/**
 * A minimal, realistic ACTIVE-position fixture for `exits/` tests that need
 * `computePositionMetrics` to produce genuine PNL/inRange values (not
 * synthetic numbers) -- e.g. `runExitCycle.test.ts`'s priority-wiring test.
 * Deliberately simpler than `tests/monitoring/computePositionMetrics.test.ts`'s
 * fixture (only one currency orientation, USDG = currency1) since exact
 * boundary-value PNL math is already exhaustively covered there and in
 * `resolveExitDecision.test.ts` -- this fixture only needs to reliably
 * produce "deeply negative PNL, out of range" and "deeply negative PNL,
 * further out of range" scenarios for wiring-level tests.
 */
const CHAIN_ID = 4663;
// Matches tests/setup.ts's fixture USDG address.
export const USDG_ADDR = '0x2222222222222222222222222222222222222222';
export const TOKEN_ADDR = '0x0000000000000000000000000000000000000002'; // sorts before USDG -> currency0=TOKEN
export const ENTRY_TICK = 0;
export const ENTRY_USDG_RAW = 1_000n * 10n ** 18n;
export const TICK_LOWER = -6960;
export const TICK_UPPER = -60;

const { TickMath } = v3TickMathUtils;

export function sqrtAt(tick: number): bigint {
  return BigInt(TickMath.getSqrtRatioAtTick(tick).toString());
}

export function deriveEntryLiquidity(): bigint {
  const usdgToken = new Token(CHAIN_ID, USDG_ADDR, 18, 'USDG');
  const tokenToken = new Token(CHAIN_ID, TOKEN_ADDR, 18, 'TOKEN');
  const poolAtEntry = new v4Sdk.Pool(
    tokenToken,
    usdgToken,
    30000,
    60,
    '0x0000000000000000000000000000000000000000',
    sqrtAt(ENTRY_TICK).toString(),
    '0',
    ENTRY_TICK,
  );
  const derived = v4Sdk.Position.fromAmount1({ pool: poolAtEntry, tickLower: TICK_LOWER, tickUpper: TICK_UPPER, amount1: ENTRY_USDG_RAW.toString() });
  return BigInt(derived.liquidity.toString());
}

export function makeExitTestPosition(overrides: Partial<PositionRecord> = {}): PositionRecord {
  return {
    id: 'pos-1',
    tokenAddress: TOKEN_ADDR as `0x${string}`,
    tokenSymbol: 'MEME',
    tokenDecimals: 18,
    pool: {
      poolId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      currency0: TOKEN_ADDR as `0x${string}`,
      currency1: USDG_ADDR as `0x${string}`,
      fee: 30000,
      tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000',
    },
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    positionTokenId: '1',
    entryUsdgRaw: ENTRY_USDG_RAW,
    entrySqrtPriceX96: sqrtAt(ENTRY_TICK),
    entryTick: ENTRY_TICK,
    status: 'ACTIVE',
    openIdempotencyKey: 'k',
    closeIdempotencyKey: null,
    openedAt: new Date(),
    closedAt: null,
    closeReason: null,
    ...overrides,
  };
}

export function livePriceState(tick: number): PoolPriceState {
  return { sqrtPriceX96: sqrtAt(tick), tickCurrent: tick };
}

export function liveState(liquidity: bigint): LivePositionState {
  return { liquidity, tokensOwed0: 0n, tokensOwed1: 0n };
}

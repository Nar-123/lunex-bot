import type { Address } from 'viem';
import type { CreatePositionInput, PositionPoolContext } from '../../src/positions/types';

export const POOL: PositionPoolContext = {
  poolId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  currency0: '0x0000000000000000000000000000000000000002',
  currency1: '0x2222222222222222222222222222222222222222',
  fee: 30000,
  tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000',
};

export function makeCreateInput(overrides: Partial<CreatePositionInput> = {}): CreatePositionInput {
  return {
    tokenAddress: '0x0000000000000000000000000000000000000002' as Address,
    tokenSymbol: 'TEST',
    tokenDecimals: 18,
    pool: POOL,
    tickLower: -6960,
    tickUpper: -60,
    entryUsdgRaw: 1_000n * 10n ** 18n,
    entrySqrtPriceX96: 2n ** 96n,
    entryTick: 0,
    openIdempotencyKey: `deploy:${overrides.tokenAddress ?? '0x0000000000000000000000000000000000000002'}:1`,
    ...overrides,
  };
}

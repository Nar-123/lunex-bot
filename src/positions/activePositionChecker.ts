import type { Address } from 'viem';
import type { ActivePositionChecker } from '../filters/types';
import type { PositionRepository } from './types';

/**
 * Real implementation of `filters/types.ts`'s `ActivePositionChecker` --
 * the port `screenCandidate()` (Module 2) has depended on since the
 * "1 coin = 1 position" duplicate-check was first designed, left
 * unimplemented until this module existed to back it.
 */
export class PositionActivePositionChecker implements ActivePositionChecker {
  constructor(private readonly positions: PositionRepository) {}

  async hasActivePosition(tokenAddress: string): Promise<boolean> {
    const position = await this.positions.findActiveByToken(tokenAddress as Address);
    return position !== null;
  }
}

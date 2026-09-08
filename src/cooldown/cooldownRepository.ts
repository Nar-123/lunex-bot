import { getAddress } from 'viem';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../storage/prismaClient';
import type { CooldownChecker, CooldownStatus } from '../filters/types';
import { computeCooldownEndsAt, computeCooldownStatus } from './cooldownLogic';

function normalizeAddress(address: string): string {
  return getAddress(address).toLowerCase();
}

/**
 * Real, persistent (never in-memory-only, per the project's storage
 * principles) per-token cooldown tracking. Implements `CooldownChecker`
 * (from `filters/types.ts`) directly, so it plugs straight into
 * `screenCandidate()` from Module 2 unchanged.
 */
export class PrismaCooldownRepository implements CooldownChecker {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  /** Starts (or restarts) a token's 2h cooldown. Called by `exits/` (Module 8) once a position closes. */
  async recordExit(tokenAddress: string, exitedAt: Date = new Date()): Promise<void> {
    const address = normalizeAddress(tokenAddress);
    const cooldownEndsAt = computeCooldownEndsAt(exitedAt);
    await this.prisma.tokenCooldown.upsert({
      where: { tokenAddress: address },
      create: { tokenAddress: address, exitedAt, cooldownEndsAt },
      update: { exitedAt, cooldownEndsAt },
    });
  }

  async getCooldownStatus(tokenAddress: string): Promise<CooldownStatus> {
    const address = normalizeAddress(tokenAddress);
    const record = await this.prisma.tokenCooldown.findUnique({ where: { tokenAddress: address } });
    return computeCooldownStatus(record?.cooldownEndsAt ?? null);
  }

  /**
   * Every token CURRENTLY in cooldown (`GET /cooldowns`, Module 10) -- a
   * genuinely new listing query (nothing before this needed "every token in
   * cooldown," only "is THIS token in cooldown"), but reuses the existing
   * pure `computeCooldownStatus` for the remaining-time math per row rather
   * than inventing new cooldown logic, same "expose a new primitive, reuse
   * the existing calculator" pattern as `findAllOpening`/`findNonTerminal`
   * in prior modules. Rows already past `cooldownEndsAt` are filtered at
   * the query level (not just left to `computeCooldownStatus` to report
   * `inCooldown: false` for) so this stays a genuinely "active only" list.
   */
  async findAllActive(now: Date = new Date()): Promise<Array<{ tokenAddress: string; remainingMs: number; cooldownEndsAt: number }>> {
    const rows = await this.prisma.tokenCooldown.findMany({ where: { cooldownEndsAt: { gt: now } } });
    return rows.map((row) => {
      const status = computeCooldownStatus(row.cooldownEndsAt, now.getTime());
      // status.inCooldown is guaranteed true here (query already filtered to cooldownEndsAt > now), so cooldownEndsAt is always present.
      return { tokenAddress: row.tokenAddress, remainingMs: status.remainingMs, cooldownEndsAt: status.cooldownEndsAt as number };
    });
  }
}

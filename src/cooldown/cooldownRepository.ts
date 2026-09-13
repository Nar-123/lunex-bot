import { getAddress } from 'viem';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../storage/prismaClient';
import type { CooldownChecker, CooldownStatus } from '../filters/types';
import { computeCooldownEndsAt, computeCooldownStatus } from './cooldownLogic';

function normalizeAddress(address: string): string {
  return getAddress(address).toLowerCase();
}

/** Nullable-safe "later of two dates" -- either argument may be absent. */
function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
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

  /**
   * H17 fix: `TokenCooldown`'s own row is written by a SEPARATE call
   * (`recordExit`, from `composition/exitCycle.ts`) AFTER
   * `Position.markClosed` already committed -- a crash between the two
   * (or the position row itself catching up, or a currently-executing
   * `recordExit` that hasn't landed yet) leaves this row missing/stale
   * while the position is nonetheless genuinely CLOSED. Introducing a
   * cross-repository `$transaction` here would mean `exits/` (which
   * currently has no dependency on `cooldown/` at all -- confirmed by
   * grep, `recordExit` is only ever called from the composition root)
   * taking on that dependency, a materially bigger architectural change
   * than this bug warrants. Instead, this reconstructs the SAME
   * information deterministically: a CLOSED position's own `closedAt` is
   * durably persisted by `markClosed` itself, so the cooldown it implies
   * can always be recomputed from it, independent of whether the
   * dedicated `TokenCooldown` upsert ever happened. Effective cooldown is
   * the LATER of whatever the dedicated row says and whatever the most
   * recent closed position implies -- never weaker than either source
   * alone.
   */
  async getCooldownStatus(tokenAddress: string): Promise<CooldownStatus> {
    const address = normalizeAddress(tokenAddress);
    const [record, lastClosed] = await Promise.all([
      this.prisma.tokenCooldown.findUnique({ where: { tokenAddress: address } }),
      this.prisma.position.findFirst({ where: { tokenAddress: address, status: 'CLOSED' }, orderBy: { closedAt: 'desc' } }),
    ]);
    const recordEndsAt = record?.cooldownEndsAt ?? null;
    const reconstructedEndsAt = lastClosed?.closedAt ? computeCooldownEndsAt(lastClosed.closedAt) : null;
    const effectiveEndsAt = laterOf(recordEndsAt, reconstructedEndsAt);
    return computeCooldownStatus(effectiveEndsAt);
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

import { getAddress } from 'viem';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../storage/prismaClient';
import type { CooldownChecker, CooldownStatus } from '../filters/types';
import { computeCooldownEndsAt, computeCooldownStatus } from './cooldownLogic';
import { config } from '../config';

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

  /**
   * Starts (or restarts) a token's cooldown. NOT on the exit path any more:
   * exits record their cooldown atomically inside
   * `PositionRepository.markClosed` (cooldown crash-gap fix). Kept as the
   * repository primitive (tests, manual/admin use).
   */
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
   * H17 fix (kept as defense-in-depth): `TokenCooldown`'s own row USED TO be
   * written by a SEPARATE call (`recordExit`, from
   * `composition/exitCycle.ts`) AFTER `Position.markClosed` already
   * committed. Since the cooldown crash-gap fix `markClosed` writes it in
   * the same transaction, so a NEW close can no longer lack it; this
   * reconstruction still covers rows closed before that fix. Originally: a crash between the two
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
    // Cooldown crash-gap fix: the SAME "later of the dedicated row and the
    // most recent close" rule `getCooldownStatus` (the screening gate) uses,
    // so the listing can never disagree with what screening enforces -- a
    // close finalized before the atomic `markClosed` fix whose row was lost
    // to the old crash window still shows here.
    const closedSince = new Date(now.getTime() - config.rules.cooldown.DURATION_MS);
    const [rows, recentClosed] = await Promise.all([
      this.prisma.tokenCooldown.findMany({ where: { cooldownEndsAt: { gt: now } } }),
      this.prisma.position.findMany({ where: { status: 'CLOSED', closedAt: { gt: closedSince } }, select: { tokenAddress: true, closedAt: true } }),
    ]);
    const endsAtByToken = new Map<string, Date>();
    for (const row of rows) endsAtByToken.set(row.tokenAddress, row.cooldownEndsAt);
    for (const p of recentClosed) {
      if (!p.closedAt) continue;
      const reconstructed = computeCooldownEndsAt(p.closedAt);
      const later = laterOf(endsAtByToken.get(p.tokenAddress) ?? null, reconstructed);
      if (later) endsAtByToken.set(p.tokenAddress, later);
    }
    const out: Array<{ tokenAddress: string; remainingMs: number; cooldownEndsAt: number }> = [];
    for (const [tokenAddress, endsAt] of endsAtByToken) {
      const status = computeCooldownStatus(endsAt, now.getTime());
      if (status.inCooldown && status.cooldownEndsAt !== undefined) out.push({ tokenAddress, remainingMs: status.remainingMs, cooldownEndsAt: status.cooldownEndsAt });
    }
    return out;
  }
}

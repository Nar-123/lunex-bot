import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import type { Address } from 'viem';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../storage/prismaClient';
import type { CreateIfCapitalAllowsResult, CreatePositionInput, PositionRecord, PositionRepository, PositionStatus } from './types';
import { DuplicateActiveTokenPositionError } from './types';
import { decideCapitalAllocation } from '../capital/decideCapitalAllocation';
import { checkCapitalStateConsistent, deriveCapitalSnapshot } from '../capital/freshCapitalSnapshot';
import type { CapitalRules } from '../capital/types';

interface PrismaRow {
  id: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  tickLower: number;
  tickUpper: number;
  positionTokenId: string | null;
  entryUsdgRaw: string;
  entrySqrtPriceX96: string;
  entryTick: number;
  status: string;
  openIdempotencyKey: string;
  closeIdempotencyKey: string | null;
  openedAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  realizedUsdgRaw: string | null;
}

function normalizeAddress(address: string): Address {
  return getAddress(address).toLowerCase() as Address;
}

/**
 * P1-1: lock-contention failures from `createIfCapitalAllows`'s
 * transaction -- SQLite's busy error once better-sqlite3's busy timeout
 * expires, or Prisma's interactive-transaction maxWait/timeout (P2028).
 * Exported for direct unit testing of the classification.
 */
export function isCapitalLockContention(message: string): boolean {
  return /SQLITE_BUSY|database is locked|P2028|Transaction API error|Unable to start a transaction|Transaction already closed|timed out/i.test(message);
}

function toRecord(row: PrismaRow): PositionRecord {
  return {
    id: row.id,
    tokenAddress: row.tokenAddress as Address,
    tokenSymbol: row.tokenSymbol,
    tokenDecimals: row.tokenDecimals,
    pool: {
      poolId: row.poolId as `0x${string}`,
      currency0: row.currency0 as Address,
      currency1: row.currency1 as Address,
      fee: row.fee,
      tickSpacing: row.tickSpacing,
      hooks: row.hooks as Address,
    },
    tickLower: row.tickLower,
    tickUpper: row.tickUpper,
    positionTokenId: row.positionTokenId,
    entryUsdgRaw: BigInt(row.entryUsdgRaw),
    entrySqrtPriceX96: BigInt(row.entrySqrtPriceX96),
    entryTick: row.entryTick,
    status: row.status as PositionStatus,
    openIdempotencyKey: row.openIdempotencyKey,
    closeIdempotencyKey: row.closeIdempotencyKey,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    closeReason: row.closeReason,
    realizedUsdgRaw: row.realizedUsdgRaw === null ? null : BigInt(row.realizedUsdgRaw),
  };
}

/** Any status other than CLOSED still occupies the token's "1 coin = 1 position" slot. */
const NON_CLOSED_STATUSES = ['OPENING', 'ACTIVE', 'CLOSING'];

export class PrismaPositionRepository implements PositionRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  async create(input: CreatePositionInput): Promise<PositionRecord> {
    const normalizedToken = normalizeAddress(input.tokenAddress);
    try {
      const row = await this.prisma.position.create({
        data: {
          tokenAddress: normalizedToken,
          tokenSymbol: input.tokenSymbol,
          tokenDecimals: input.tokenDecimals,
          poolId: input.pool.poolId,
          currency0: input.pool.currency0,
          currency1: input.pool.currency1,
          fee: input.pool.fee,
          tickSpacing: input.pool.tickSpacing,
          hooks: input.pool.hooks,
          tickLower: input.tickLower,
          tickUpper: input.tickUpper,
          entryUsdgRaw: input.entryUsdgRaw.toString(),
          entrySqrtPriceX96: input.entrySqrtPriceX96.toString(),
          entryTick: input.entryTick,
          status: 'OPENING',
          openIdempotencyKey: input.openIdempotencyKey,
        },
      });
      return toRecord(row);
    } catch (err) {
      // P1-2 fix: the partial unique index `Position_tokenAddress_active_unique`
      // (raw SQL, see prisma/schema.prisma's doc comment) is what actually
      // enforces "1 token = 1 non-closed position" atomically -- this
      // catch translates its violation into a specific, catchable error
      // instead of leaking a raw Prisma/SQLite exception.
      //
      // IMPORTANT (verified against a real error, not guessed): Prisma's
      // error message ALWAYS includes a source-code snippet from the
      // CALLING file around the throw site -- since this catch itself
      // lives right next to a `data: { tokenAddress: normalizedToken,
      // ... }` literal, the word "tokenAddress" appears in EVERY error
      // from this call site regardless of which field actually violated a
      // constraint (confirmed: an `openIdempotencyKey` violation's message
      // ALSO contains "tokenAddress" for exactly this reason). The only
      // reliable signal is Prisma's own precise field-list line, e.g.
      // "Unique constraint failed on the fields: (`tokenAddress`)" --
      // matched here as a whole backtick-quoted token, never a loose
      // substring check against the full message.
      const message = err instanceof Error ? err.message : String(err);
      if (/unique constraint failed on the fields:\s*\(`tokenAddress`\)/i.test(message)) {
        throw new DuplicateActiveTokenPositionError(normalizedToken);
      }
      throw err;
    }
  }

  async createIfCapitalAllows(
    input: CreatePositionInput,
    readOnChainUsdgBalance: () => Promise<bigint>,
    rules: CapitalRules,
  ): Promise<CreateIfCapitalAllowsResult> {
    const normalizedToken = normalizeAddress(input.tokenAddress);

    // P1-1 cross-process fix, step 1 -- ORDER MATTERS: read the non-closed
    // row set FIRST, THEN the raw on-chain balance. Any status transition
    // that could move the balance after this row read is then guaranteed to
    // be visible to `checkCapitalStateConsistent` under the lock below (see
    // its doc comment). Reading the balance first would let an
    // OPENING->ACTIVE (mint debited the wallet) slip in between unnoticed.
    const observedRows = await this.prisma.position.findMany({
      where: { status: { in: NON_CLOSED_STATUSES } },
      select: { id: true, status: true },
    });
    const observedBefore = new Map(observedRows.map((r) => [r.id, r.status]));
    let onChainBalance: bigint;
    try {
      onChainBalance = await readOnChainUsdgBalance();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `capital reservation aborted (fail-closed): could not read the on-chain USDG balance: ${message}` };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // P1-1 fix: touch the CapitalLock singleton row FIRST -- a real
        // WRITE statement, executed before any read below. SQLite's
        // default (deferred) transaction does not take a write lock at
        // BEGIN; it only escalates on the first statement that actually
        // writes. Verified empirically that without this, two concurrent
        // callers can both complete the findMany/count reads below (a
        // SHARED lock, which multiple readers may hold at once) before
        // either takes the write lock, each computing "fits under the
        // cap" from the SAME stale totals and then both successfully
        // writing -- silently overshooting the cap. Doing a write here
        // FIRST forces this transaction to take SQLite's RESERVED lock
        // immediately, so a second concurrent transaction's own attempt to
        // touch this same row blocks (via better-sqlite3's busy-timeout,
        // default 5000ms -- see `better-sqlite3`'s `timeout` option) until
        // this one commits, and then its own fresh read below genuinely
        // observes this one's write. This is NOT the same as Prisma's
        // `{ isolationLevel: 'Serializable' }` option, which does nothing
        // here: verified via `@prisma/adapter-better-sqlite3`'s source
        // that `startTransaction()` always issues a plain `BEGIN`
        // regardless of the requested isolation level. It is also NOT
        // redundant with that adapter's own in-process mutex
        // (`PrismaBetterSqlite3Adapter#mutex`, held from `startTransaction`
        // to `commit`) -- that mutex only serializes calls made through
        // ONE adapter instance in ONE process; a second, separate process
        // has its own independent adapter and mutex, unaware of the first,
        // and only a real SQLite file-level lock (what this write forces)
        // coordinates the two. See schema.prisma's doc comment on
        // `CapitalLock` for the full rationale.
        //
        // `timeout`/`maxWait` below are raised from Prisma's 5000ms default
        // -- verified empirically (a real two-independent-connections test,
        // see positionRepository.integration.test.ts's P1-1 cross-process
        // test) that under heavy concurrent contention on this lock, queued
        // callers can genuinely wait close to or past 5s for their turn
        // (each is a real, correct wait for the lock to free up, not a
        // stuck/deadlocked transaction), which Prisma's default timeout
        // would abort with a generic "Operation has timed out" -- a false
        // failure, not a capital-safety issue. 15s gives realistic queuing
        // room without masking an actual stuck transaction.
        await tx.capitalLock.update({ where: { id: 'singleton' }, data: { touchedAt: new Date() } });

        // P1-1 cross-process fix, step 2 -- with the lock HELD: re-read the
        // rows, prove they are still compatible with the balance read
        // above, and derive free/deployed/count from THIS SAME fresh row
        // set plus the RAW balance. The old code took a `freeUsdgBalance`
        // the caller had ALREADY derived (onChain - OPENING at sizing
        // time) and added a FRESH deployed sum -- every OPENING row a
        // concurrent process created in between was then counted twice
        // (still inside the stale "free" figure AND in the fresh deployed
        // sum), inflating the base and letting 3 callers reserve 1050
        // against a 950 cap.
        const freshRows = (
          await tx.position.findMany({
            where: { status: { in: NON_CLOSED_STATUSES } },
            select: { id: true, status: true, entryUsdgRaw: true },
          })
        ).map((r) => ({ id: r.id, status: r.status, entryUsdgRaw: BigInt(r.entryUsdgRaw) }));

        const consistency = checkCapitalStateConsistent(observedBefore, freshRows);
        if (!consistency.ok) {
          return { ok: false as const, reason: `capital reservation aborted (fail-closed, retry next cycle): ${consistency.reason}` };
        }

        const decision = decideCapitalAllocation(deriveCapitalSnapshot(onChainBalance, freshRows), rules);
        if (!decision.ok) {
          return { ok: false as const, reason: `capital reservation conflict (re-checked at write time): ${decision.reason}` };
        }
        // The ALREADY-DECIDED size (what selectPool/computeLpRange were
        // run against) must still fit the FRESHLY recomputed remaining
        // capacity -- deliberately not resized to `decision.positionSizeUsdgRaw`
        // here (see this method's doc comment on why re-negotiating a
        // smaller size at this point would invalidate the pool/range
        // already chosen for `input.entryUsdgRaw`).
        if (input.entryUsdgRaw > decision.positionSizeUsdgRaw) {
          return {
            ok: false as const,
            reason: `capital reservation conflict (re-checked at write time): a concurrent reservation reduced remaining capacity below the already-decided size (${input.entryUsdgRaw} > ${decision.positionSizeUsdgRaw} now available)`,
          };
        }

        const row = await tx.position.create({
          data: {
            tokenAddress: normalizedToken,
            tokenSymbol: input.tokenSymbol,
            tokenDecimals: input.tokenDecimals,
            poolId: input.pool.poolId,
            currency0: input.pool.currency0,
            currency1: input.pool.currency1,
            fee: input.pool.fee,
            tickSpacing: input.pool.tickSpacing,
            hooks: input.pool.hooks,
            tickLower: input.tickLower,
            tickUpper: input.tickUpper,
            entryUsdgRaw: input.entryUsdgRaw.toString(),
            entrySqrtPriceX96: input.entrySqrtPriceX96.toString(),
            entryTick: input.entryTick,
            status: 'OPENING',
            openIdempotencyKey: input.openIdempotencyKey,
          },
        });
        return { ok: true as const, record: toRecord(row) };
      }, { timeout: 15_000, maxWait: 15_000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/unique constraint failed on the fields:\s*\(`tokenAddress`\)/i.test(message)) {
        // P1-2's protection composes with P1-1's: the SAME transaction
        // this creates in can also hit the partial unique index if a
        // concurrent OPENING for this token was created between this
        // candidate's earlier duplicatePosition.ts filter check and here.
        throw new DuplicateActiveTokenPositionError(normalizedToken);
      }
      if (isCapitalLockContention(message)) {
        // P1-1: the lock could not be acquired in time (SQLITE_BUSY after
        // better-sqlite3's busy timeout, or Prisma's own transaction
        // maxWait/timeout). Nothing was written -- the whole transaction,
        // CapitalLock touch included, is rolled back -- and nothing
        // proceeds without the lock: fail closed with an explicit reason.
        return { ok: false, reason: `capital reservation aborted (fail-closed): CapitalLock unavailable: ${message}` };
      }
      throw err;
    }
  }

  async findById(id: string): Promise<PositionRecord | null> {
    const row = await this.prisma.position.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async findActiveByToken(tokenAddress: Address): Promise<PositionRecord | null> {
    const row = await this.prisma.position.findFirst({
      where: { tokenAddress: normalizeAddress(tokenAddress), status: { in: NON_CLOSED_STATUSES } },
    });
    return row ? toRecord(row) : null;
  }

  async findAllActive(): Promise<PositionRecord[]> {
    const rows = await this.prisma.position.findMany({ where: { status: 'ACTIVE' } });
    return rows.map(toRecord);
  }

  async findAllClosing(): Promise<PositionRecord[]> {
    const rows = await this.prisma.position.findMany({ where: { status: 'CLOSING' } });
    return rows.map(toRecord);
  }

  async findAllOpening(): Promise<PositionRecord[]> {
    // H1 fix: deterministic ordering (oldest-created first) -- without
    // this, iteration order over a resume pass is whatever the DB engine
    // happens to return, which can vary between calls/engines, making
    // "which position gets processed before a mid-pass crash" impossible
    // to reason about consistently.
    const rows = await this.prisma.position.findMany({ where: { status: 'OPENING' }, orderBy: { createdAt: 'asc' } });
    return rows.map(toRecord);
  }

  async findAllClosed(): Promise<PositionRecord[]> {
    const rows = await this.prisma.position.findMany({ where: { status: 'CLOSED' }, orderBy: { closedAt: 'desc' } });
    return rows.map(toRecord);
  }

  async findDeployedPositions(): Promise<PositionRecord[]> {
    // OPENING + ACTIVE + CLOSING -- see types.ts for why OPENING belongs
    // here too (its capital is still sitting in the wallet on-chain, but
    // is functionally already committed to a specific transaction).
    const rows = await this.prisma.position.findMany({ where: { status: { in: NON_CLOSED_STATUSES } } });
    return rows.map(toRecord);
  }

  async countNonClosed(): Promise<number> {
    return this.prisma.position.count({ where: { status: { in: NON_CLOSED_STATUSES } } });
  }

  async markActive(id: string, positionTokenId: string, openedAt: Date): Promise<PositionRecord> {
    const row = await this.prisma.position.update({
      where: { id },
      data: { status: 'ACTIVE', positionTokenId, openedAt },
    });
    return toRecord(row);
  }

  async markClosing(id: string, closeIdempotencyKey: string): Promise<PositionRecord> {
    const row = await this.prisma.position.update({
      where: { id },
      data: { status: 'CLOSING', closeIdempotencyKey },
    });
    return toRecord(row);
  }

  async markClosed(id: string, closedAt: Date, closeReason: string, realizedUsdgRaw?: bigint | null): Promise<PositionRecord> {
    // Omitted -> null ("not measured") via Prisma's default-null on ADD COLUMN:
    // legacy callers that don't pass proceeds keep the honest unavailable state.
    const row = await this.prisma.position.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedAt,
        closeReason,
        ...(realizedUsdgRaw !== undefined && { realizedUsdgRaw: realizedUsdgRaw === null ? null : realizedUsdgRaw.toString() }),
      },
    });
    return toRecord(row);
  }

  async backfillRealizedUsdgRaw(id: string, realizedUsdgRaw: bigint): Promise<PositionRecord | null> {
    const result = await this.prisma.position.updateMany({
      where: { id, status: 'CLOSED', realizedUsdgRaw: null },
      data: { realizedUsdgRaw: realizedUsdgRaw.toString() },
    });
    if (result.count === 0) return null;
    const row = await this.prisma.position.findUniqueOrThrow({ where: { id } });
    return toRecord(row);
  }

  async markFailed(id: string): Promise<PositionRecord> {
    const row = await this.prisma.position.update({
      where: { id },
      data: { status: 'FAILED' },
    });
    return toRecord(row);
  }

  async markExitFailed(id: string): Promise<PositionRecord> {
    const row = await this.prisma.position.update({
      where: { id },
      data: { status: 'ACTIVE', closeIdempotencyKey: null },
    });
    return toRecord(row);
  }

  async claimForResume(id: string, expectedStatus: 'OPENING' | 'CLOSING', freshnessMs: number): Promise<string | null> {
    const freshnessCutoff = new Date(Date.now() - freshnessMs);
    const token = randomUUID();
    // A single conditional UPDATE -- the WHERE clause (status matches AND
    // claim is absent/expired) and the SET (touch resumeClaimedAt AND stamp
    // a fresh ownership token) are evaluated and applied by the database as
    // one atomic operation, so two concurrent callers can NEVER both see
    // `count === 1`: whichever reaches the database first wins the row and
    // the loser's WHERE clause no longer matches (resumeClaimedAt is now
    // fresh). P0-1: the generated `token` is only ever handed back to the
    // caller that actually won this UPDATE (count === 1) -- a loser never
    // learns any token, real or otherwise.
    const result = await this.prisma.position.updateMany({
      where: {
        id,
        status: expectedStatus,
        OR: [{ resumeClaimedAt: null }, { resumeClaimedAt: { lt: freshnessCutoff } }],
      },
      data: { resumeClaimedAt: new Date(), resumeClaimToken: token },
    });
    return result.count === 1 ? token : null;
  }

  async releaseResumeClaim(id: string, token: string): Promise<boolean> {
    // P0-1: conditional by id AND resumeClaimToken -- a caller whose claim
    // has since expired and been won by someone else no longer matches
    // (the row's resumeClaimToken is now a DIFFERENT random value), so this
    // UPDATE affects zero rows and the newer owner's claim is left intact.
    // Still orthogonal to `status` (which markActive/markFailed/etc.
    // already transition independently) -- safe regardless of the
    // position's current status, same as the old unconditional version.
    const result = await this.prisma.position.updateMany({
      where: { id, resumeClaimToken: token },
      data: { resumeClaimedAt: null, resumeClaimToken: null },
    });
    return result.count === 1;
  }
}

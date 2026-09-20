import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import type { Address } from 'viem';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../storage/prismaClient';
import type { CreateIfCapitalAllowsResult, CreatePositionInput, ObsoleteExitAttemptOutcome, OpeningExpiryResult, PositionRecord, PositionRepository, PositionStatus } from './types';
import { DuplicateActiveTokenPositionError, ManualSettlementTxAlreadyUsedError, openMintAttemptKey } from './types';
import type { DustSettlementEvidence, DustSettlementRecord, ManualSettlementEvidence, ManualSettlementRecord } from './types';
import { decideCapitalAllocation } from '../capital/decideCapitalAllocation';
import { checkCapitalStateConsistent, deriveCapitalSnapshot, exitLegKeyPrefix } from '../capital/freshCapitalSnapshot';
import { findAttemptsByKeyPrefixes } from '../execution/transactionAttemptRepository';
import type { CapitalRules } from '../capital/types';
import { CLEANABLE_PURPOSE, classifyStaleExitAttempt, lifecycleClosedReason, MAX_LAST_ERROR_LENGTH } from '../exits/staleExitAttemptCleanup';
import { computeCooldownEndsAt } from '../cooldown/cooldownLogic';

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

/** H3: mint-attempt statuses at which the mint MAY have been broadcast (SIGNED is persisted before broadcasting) but is not yet resolved -- an OPENING in this state is never expired. */
const MINT_POSSIBLY_BROADCAST = new Set(['SIGNED', 'SENT', 'CONFIRMED']);

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

        // AI Supervisor entry control: re-read the entry state with the lock
        // HELD, immediately before the max-position/capital checks and the
        // insert. A pause (operator or AI) is a write that needs this same
        // SQLite write lock, so it is linearizable with this reservation:
        // committed before -> seen here and nothing is reserved; committed
        // after -> this position was admitted before the pause took effect.
        // The screening-cycle-start check alone could not stop a cycle that
        // was already iterating candidates.
        const entry = await tx.botSettings.findUnique({ where: { id: 'singleton' }, select: { paused: true, aiEntryPaused: true } });
        if (entry?.paused || entry?.aiEntryPaused) {
          const by = entry.paused ? ('OPERATOR' as const) : ('AI' as const);
          return { ok: false as const, reason: `entry paused (${by === 'AI' ? 'AI supervisor' : 'operator'}) -- no new position reserved`, entryPausedBy: by };
        }

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
            select: { id: true, status: true, entryUsdgRaw: true, closeIdempotencyKey: true },
          })
        ).map((r) => ({ id: r.id, status: r.status, entryUsdgRaw: BigInt(r.entryUsdgRaw), closeIdempotencyKey: r.closeIdempotencyKey }));

        const consistency = checkCapitalStateConsistent(observedBefore, freshRows);
        if (!consistency.ok) {
          return { ok: false as const, reason: `capital reservation aborted (fail-closed, retry next cycle): ${consistency.reason}` };
        }

        // H2: CLOSING rows' exit legs, read inside the SAME locked
        // transaction and AFTER the balance read above -- any exit leg that
        // could have moved USDG into that balance is already persisted at
        // SIGNED or later (SIGNED is written before broadcast), so it shows
        // up here as either unresolved (fail closed) or VERIFIED with a
        // measured amount that deriveCapitalSnapshot then removes from the
        // deployed figure. Returned USDG is never counted as both wallet
        // capital and deployed capital.
        const closePrefixes = freshRows.filter((r) => r.status === 'CLOSING' && r.closeIdempotencyKey).map((r) => exitLegKeyPrefix(r.closeIdempotencyKey as string));
        const exitLegAttempts = await findAttemptsByKeyPrefixes(tx, closePrefixes);

        const decision = decideCapitalAllocation(deriveCapitalSnapshot(onChainBalance, freshRows, exitLegAttempts), rules);
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

  /**
   * Stale-writer fix: every lifecycle transition below is ONE conditional
   * UPDATE on the expected prior state (`WHERE id = ? AND status = ?`, plus
   * the close key where one exists), returning `null` -- nothing written --
   * when the row has already moved on. A stale worker can therefore never
   * move a position backwards (e.g. CLOSING -> ACTIVE via a late
   * markActive, CLOSED -> ACTIVE via a late markExitFailed) or re-key an
   * exit another worker already started.
   */
  private async transition(where: Record<string, unknown>, data: Record<string, unknown>): Promise<PositionRecord | null> {
    const result = await this.prisma.position.updateMany({ where, data });
    if (result.count !== 1) return null;
    return toRecord(await this.prisma.position.findUniqueOrThrow({ where: { id: where.id as string } }));
  }

  async markActive(id: string, positionTokenId: string, openedAt: Date): Promise<PositionRecord | null> {
    return this.transition({ id, status: 'OPENING' }, { status: 'ACTIVE', positionTokenId, openedAt });
  }

  async markClosing(id: string, closeIdempotencyKey: string): Promise<PositionRecord | null> {
    return this.transition({ id, status: 'ACTIVE' }, { status: 'CLOSING', closeIdempotencyKey });
  }

  /**
   * Cooldown crash-gap fix: the CLOSED transition, the realized proceeds and
   * the token's exit cooldown are committed in ONE database transaction.
   * Before this, the cooldown row was written by a separate, later
   * `recordExit()` call in `composition/exitCycle.ts`, AFTER this update had
   * already committed -- a crash in between left a CLOSED position with no
   * `TokenCooldown` row (screening still reconstructed the cooldown from
   * `closedAt` -- the H17 read-side fallback, kept -- but the durable record
   * and everything that lists it did not have it).
   *
   * Order inside the transaction: the conditional CLOSING -> CLOSED update
   * runs FIRST (a write, so SQLite takes the write lock immediately, same
   * pattern as CapitalLock); ONLY if it actually won (count === 1) is the
   * cooldown written, from the SAME `closedAt` -- never "now", so a retry,
   * restart or recovery can never shift it. If anything in here fails, the
   * whole transaction rolls back: the position stays CLOSING (retried by the
   * next exit tick), no proceeds, no cooldown. A losing / stale / repeated
   * finalization matches zero rows and writes NOTHING -- no second cooldown,
   * no timestamp moved.
   *
   * The cooldown only ever moves FORWARD: a row whose `exitedAt` is already
   * at or after this close is left untouched (a same-token close can only
   * follow the previous one, so this never loses a later cooldown).
   */
  async markClosed(
    id: string,
    closedAt: Date,
    closeReason: string,
    realizedUsdgRaw?: bigint | null,
    expectedCloseIdempotencyKey?: string,
    manualSettlement?: ManualSettlementEvidence,
    dustSettlement?: DustSettlementEvidence,
  ): Promise<PositionRecord | null> {
    try {
      return await this.markClosedTx(id, closedAt, closeReason, realizedUsdgRaw, expectedCloseIdempotencyKey, manualSettlement, dustSettlement);
    } catch (err) {
      // Same precise field-list match as `create` above (verified against
      // the real error in manualTokenSettlement.integration.test.ts).
      const message = err instanceof Error ? err.message : String(err);
      if (manualSettlement && /unique constraint failed on the fields:\s*\(`txHash`\)/i.test(message)) {
        throw new ManualSettlementTxAlreadyUsedError(manualSettlement.txHash);
      }
      throw err;
    }
  }

  private async markClosedTx(
    id: string,
    closedAt: Date,
    closeReason: string,
    realizedUsdgRaw: bigint | null | undefined,
    expectedCloseIdempotencyKey: string | undefined,
    manualSettlement: ManualSettlementEvidence | undefined,
    dustSettlement?: DustSettlementEvidence,
  ): Promise<PositionRecord | null> {
    return this.prisma.$transaction(
      async (tx) => {
        // Omitted -> null ("not measured") via Prisma's default-null on ADD COLUMN:
        // legacy callers that don't pass proceeds keep the honest unavailable state.
        const moved = await tx.position.updateMany({
          where: { id, status: 'CLOSING', ...(expectedCloseIdempotencyKey !== undefined && { closeIdempotencyKey: expectedCloseIdempotencyKey }) },
          data: {
            status: 'CLOSED',
            closedAt,
            closeReason,
            ...(realizedUsdgRaw !== undefined && { realizedUsdgRaw: realizedUsdgRaw === null ? null : realizedUsdgRaw.toString() }),
          },
        });
        if (moved.count !== 1) return null;
        const row = await tx.position.findUniqueOrThrow({ where: { id } });

        const cooldownEndsAt = computeCooldownEndsAt(closedAt);
        const existing = await tx.tokenCooldown.findUnique({ where: { tokenAddress: row.tokenAddress } });
        if (!existing) {
          await tx.tokenCooldown.create({ data: { tokenAddress: row.tokenAddress, exitedAt: closedAt, cooldownEndsAt } });
        } else if (existing.exitedAt.getTime() < closedAt.getTime()) {
          await tx.tokenCooldown.update({ where: { tokenAddress: row.tokenAddress }, data: { exitedAt: closedAt, cooldownEndsAt } });
        }
        // Manual TOKEN settlement via receipt: the association is part of
        // the same commit -- it exists iff this close did. The txHash
        // primary key makes a transaction settle at most one position.
        if (manualSettlement) {
          await tx.manualTokenSettlement.create({
            data: {
              txHash: manualSettlement.txHash,
              positionId: id,
              closeIdempotencyKey: row.closeIdempotencyKey ?? '',
              tokenDisposedRaw: manualSettlement.tokenDisposedRaw.toString(),
              usdgProceedsRaw: manualSettlement.usdgProceedsRaw.toString(),
              blockNumber: manualSettlement.blockNumber.toString(),
              settledAt: closedAt,
            },
          });
        }
        // Operator-authorised DUST settlement: the abandonment record exists
        // iff this close did. `positionId` is the primary key, so a repeated
        // request can never write a second row (and never double-closes,
        // because the conditional transition above already matched 0 rows).
        if (dustSettlement) {
          await tx.dustSettlement.create({
            data: {
              positionId: id,
              closeIdempotencyKey: row.closeIdempotencyKey ?? '',
              tokenAddress: dustSettlement.tokenAddress,
              tokenDecimals: dustSettlement.tokenDecimals,
              residualTokenRaw: dustSettlement.residualTokenRaw.toString(),
              quotedUsdgRaw: dustSettlement.quotedUsdgRaw.toString(),
              thresholdUsdgRaw: dustSettlement.thresholdUsdgRaw.toString(),
              quotedAt: dustSettlement.quotedAt,
              settledAt: closedAt,
              actor: dustSettlement.actor,
              requestId: dustSettlement.requestId,
            },
          });
        }
        return toRecord(row);
      },
      { timeout: 15_000, maxWait: 15_000 },
    );
  }

  async findDustSettlementByPositionId(positionId: string): Promise<DustSettlementRecord | null> {
    const row = await this.prisma.dustSettlement.findUnique({ where: { positionId } });
    if (!row) return null;
    return {
      positionId: row.positionId,
      closeIdempotencyKey: row.closeIdempotencyKey,
      tokenAddress: row.tokenAddress,
      tokenDecimals: row.tokenDecimals,
      residualTokenRaw: BigInt(row.residualTokenRaw),
      quotedUsdgRaw: BigInt(row.quotedUsdgRaw),
      thresholdUsdgRaw: BigInt(row.thresholdUsdgRaw),
      quotedAt: row.quotedAt,
      settledAt: row.settledAt,
      actor: row.actor,
      requestId: row.requestId,
    };
  }

  async findManualSettlementByTxHash(txHash: string): Promise<ManualSettlementRecord | null> {
    const row = await this.prisma.manualTokenSettlement.findUnique({ where: { txHash: txHash.toLowerCase() } });
    if (!row) return null;
    return {
      txHash: row.txHash,
      positionId: row.positionId,
      closeIdempotencyKey: row.closeIdempotencyKey,
      tokenDisposedRaw: BigInt(row.tokenDisposedRaw),
      usdgProceedsRaw: BigInt(row.usdgProceedsRaw),
      blockNumber: BigInt(row.blockNumber),
      settledAt: row.settledAt,
    };
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

  async markFailed(id: string): Promise<PositionRecord | null> {
    return this.transition({ id, status: 'OPENING' }, { status: 'FAILED' });
  }

  async markExitFailed(id: string, closeIdempotencyKey: string): Promise<PositionRecord | null> {
    return this.transition({ id, status: 'CLOSING', closeIdempotencyKey }, { status: 'ACTIVE', closeIdempotencyKey: null });
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

  /**
   * Maintenance fence for obsolete exit legs of CLOSED positions. Mirrors the
   * H3 `expireStaleOpening` fence: one transaction, a version+status CAS on
   * every write, and a hard failure (rolling the whole transaction back) if a
   * CAS does not match exactly one row -- a concurrent writer moved the row,
   * so this decision was made on stale data and none of it may stand.
   *
   * Reads nothing but the named positions and their own exit legs, and writes
   * nothing but qualifying attempt rows. Positions, capital and every other
   * attempt are untouched.
   */
  async fenceObsoleteExitAttempts(positionIds: readonly string[], now: Date): Promise<ObsoleteExitAttemptOutcome[]> {
    if (positionIds.length === 0) return [];
    return this.prisma.$transaction(async (tx) => {
      const results: ObsoleteExitAttemptOutcome[] = [];
      for (const positionId of positionIds) {
        const position = await tx.position.findUnique({ where: { id: positionId }, select: { id: true, status: true, closeReason: true, closeIdempotencyKey: true } });
        if (!position) { results.push({ positionId, outcome: 'POSITION_NOT_FOUND' }); continue; }
        if (position.status !== 'CLOSED') { results.push({ positionId, outcome: 'POSITION_NOT_CLOSED' }); continue; }
        if (!position.closeIdempotencyKey) { results.push({ positionId, outcome: 'NO_CLOSE_KEY' }); continue; }

        // Scope: only this lifecycle's own legs, and only the swap purpose.
        const legs = await tx.transactionAttempt.findMany({
          where: { idempotencyKey: { startsWith: exitLegKeyPrefix(position.closeIdempotencyKey) }, purpose: CLEANABLE_PURPOSE },
          orderBy: { idempotencyKey: 'asc' },
        });
        for (const leg of legs) {
          const decision = classifyStaleExitAttempt(position, leg);
          const common = { positionId, attemptId: leg.id, idempotencyKey: leg.idempotencyKey, purpose: leg.purpose };
          if (decision.action === 'SKIP') { results.push({ ...common, outcome: 'SKIPPED', reason: decision.reason }); continue; }

          const fenced = await tx.transactionAttempt.updateMany({
            where: { id: leg.id, version: leg.version, status: leg.status, nonce: null, txHash: null, rawTx: null },
            data: {
              status: 'FAILED',
              failureCode: 'LIFECYCLE_CLOSED',
              lastError: lifecycleClosedReason(position, leg.attemptCount).slice(0, MAX_LAST_ERROR_LENGTH),
              updatedAt: now,
              version: { increment: 1 },
            },
          });
          if (fenced.count !== 1) {
            // A concurrent writer advanced this row between the read and the
            // CAS. The whole batch is abandoned rather than partially applied.
            throw new Error(`fenceObsoleteExitAttempts: CAS matched ${fenced.count} rows for attempt ${leg.id} (expected 1) -- concurrent modification, nothing was changed`);
          }
          results.push({ ...common, outcome: 'FENCED', statusBefore: leg.status, attemptCount: leg.attemptCount });
        }
      }
      return results;
    });
  }

  async expireStaleOpening(id: string, maxAgeMs: number, now: Date): Promise<OpeningExpiryResult> {
    // Cheap pre-check outside the lock: most calls are young/non-OPENING
    // rows and must not contend for the database write lock every tick.
    const peek = await this.prisma.position.findUnique({ where: { id }, select: { status: true, createdAt: true } });
    if (!peek || peek.status !== 'OPENING') return { outcome: 'NOT_OPENING' };
    const peekAge = now.getTime() - peek.createdAt.getTime();
    if (peekAge < maxAgeMs) return { outcome: 'TOO_YOUNG', ageMs: peekAge };

    return this.prisma.$transaction(async (tx) => {
      // Same write-first lock escalation as createIfCapitalAllows: every
      // read below happens under SQLite's RESERVED write lock, so no other
      // writer (another process's SIGNED CAS write, a concurrent expiry,
      // a capital reservation) can interleave until this commits.
      await tx.capitalLock.update({ where: { id: 'singleton' }, data: { touchedAt: new Date() } });

      const row = await tx.position.findUnique({ where: { id }, select: { status: true, createdAt: true, openIdempotencyKey: true } });
      if (!row || row.status !== 'OPENING') return { outcome: 'NOT_OPENING' as const };
      const ageMs = now.getTime() - row.createdAt.getTime();
      if (ageMs < maxAgeMs) return { outcome: 'TOO_YOUNG' as const, ageMs };

      const mintKey = openMintAttemptKey(row.openIdempotencyKey);
      const mint = await tx.transactionAttempt.findUnique({ where: { idempotencyKey: mintKey }, select: { id: true, status: true, version: true } });
      const lastError = `OPENING expired after ${ageMs}ms (max ${maxAgeMs}ms) with no broadcast mint -- reservation released`;

      // Stuck-transaction audit: this lifecycle's USDG approve. One that may
      // have been broadcast (SIGNED is persisted BEFORE broadcasting) blocks
      // the expiry exactly like a possibly-broadcast mint -- never FAILED
      // while it could still land (it would leave an unwanted allowance for
      // a FAILED position). One still before SIGNED is fenced FAILED below,
      // in this same transaction, with a version CAS -- executeCriticalTransaction
      // re-reads the row inside the executor lock and stops on FAILED, so it
      // can never be signed or broadcast afterwards.
      const approveKey = `${row.openIdempotencyKey}:approve`;
      const approve = await tx.transactionAttempt.findUnique({ where: { idempotencyKey: approveKey }, select: { id: true, status: true, version: true } });
      if (mint?.status === 'VERIFIED') return { outcome: 'MINT_VERIFIED' as const };
      if (mint && MINT_POSSIBLY_BROADCAST.has(mint.status)) return { outcome: 'BLOCKED_UNRESOLVED_TX' as const, mintStatus: mint.status };
      if (approve && MINT_POSSIBLY_BROADCAST.has(approve.status)) {
        return { outcome: 'BLOCKED_UNRESOLVED_TX' as const, mintStatus: mint?.status ?? 'NONE', approveStatus: approve.status };
      }
      if (approve && approve.status !== 'FAILED' && approve.status !== 'VERIFIED') {
        const fencedApprove = await tx.transactionAttempt.updateMany({
          where: { id: approve.id, version: approve.version, status: approve.status },
          data: { status: 'FAILED', failureCode: 'OPENING_TIMEOUT', lastError: `OPENING expired after ${ageMs}ms (max ${maxAgeMs}ms) before this approve was signed -- fenced`, version: { increment: 1 } },
        });
        if (fencedApprove.count !== 1) {
          // Unreachable under the write lock; never release on a failed fence.
          return { outcome: 'BLOCKED_UNRESOLVED_TX' as const, mintStatus: mint?.status ?? 'NONE', approveStatus: approve.status };
        }
      }

      if (mint === null) {
        // Fence the key: a worker that has not created its mint attempt yet
        // (e.g. still on the approve leg) will find this FAILED row -- or
        // collide with it on the unique key -- and can never build a mint.
        await tx.transactionAttempt.create({ data: { idempotencyKey: mintKey, purpose: 'deploy:mint', status: 'FAILED', failureCode: 'OPENING_TIMEOUT', lastError } });
      } else if (mint.status !== 'FAILED') {
        // Before SIGNED: nothing was ever broadcast. CAS on version so an
        // in-flight worker's next checkpoint write (SIGNED is written
        // BEFORE broadcasting) fails with a stale-version error.
        const fenced = await tx.transactionAttempt.updateMany({
          where: { id: mint.id, version: mint.version, status: mint.status },
          data: { status: 'FAILED', failureCode: 'OPENING_TIMEOUT', lastError, version: { increment: 1 } },
        });
        if (fenced.count !== 1) {
          // Unreachable under the write lock; never release on a failed fence.
          return { outcome: 'BLOCKED_UNRESOLVED_TX' as const, mintStatus: mint.status };
        }
      }

      const moved = await tx.position.updateMany({ where: { id, status: 'OPENING' }, data: { status: 'FAILED' } });
      if (moved.count !== 1) return { outcome: 'NOT_OPENING' as const };
      return { outcome: 'EXPIRED' as const, mintStatusBefore: mint?.status ?? null };
    }, { timeout: 15_000, maxWait: 15_000 });
  }
}

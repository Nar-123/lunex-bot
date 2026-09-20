import type { Address } from 'viem';
import { getAddress } from 'viem';
import type { CreateIfCapitalAllowsResult, CreatePositionInput, DustSettlementEvidence, DustSettlementRecord, ManualSettlementEvidence, ManualSettlementRecord, OpeningExpiryResult, PositionRecord, PositionRepository } from '../../src/positions/types';
import { DuplicateActiveTokenPositionError, ManualSettlementTxAlreadyUsedError, openMintAttemptKey } from '../../src/positions/types';
import { decideCapitalAllocation } from '../../src/capital/decideCapitalAllocation';
import type { CapitalRules } from '../../src/capital/types';
import { checkCapitalStateConsistent, deriveCapitalSnapshot, exitLegKeyPrefix } from '../../src/capital/freshCapitalSnapshot';
import type { TransactionAttemptRepository } from '../../src/execution/types';

const NON_CLOSED = new Set(['OPENING', 'ACTIVE', 'CLOSING']);

/** In-memory test double, same role as the other modules' in-memory repos: fast, no DB, for testing logic built ON TOP of the repository interface. */
export class InMemoryPositionRepository implements PositionRepository {
  private byId = new Map<string, PositionRecord>();
  private claimedAt = new Map<string, number>();
  private claimToken = new Map<string, string>();
  private nextId = 1;
  private nextTokenSeq = 1;
  /** H3: mirrors the real `Position.createdAt` column (set once at insert, never touched again). */
  private createdAt = new Map<string, Date>();

  /** H2: optional -- lets `createIfCapitalAllows` account for CLOSING positions' exit legs exactly like the real repository (without it, a CLOSING row makes capital unresolved, fail closed -- also exactly like the real derivation). */
  /**
   * Cooldown crash-gap fix: `cooldown` mirrors the real repository writing
   * the exit cooldown inside `markClosed`'s transaction -- when given, a
   * winning `markClosed` records it (from `closedAt`), and a failed record
   * rolls the close back, exactly like the real transaction.
   */
  constructor(
    private readonly txAttempts?: TransactionAttemptRepository,
    private readonly cooldown?: { recordExit(tokenAddress: string, exitedAt?: Date): Promise<void> },
  ) {}

  /** AI entry control: mirrors the real repository's entry-state re-read under CapitalLock (wired to the settings repository by fakeAppDeps). */
  entryGate?: () => Promise<{ paused: boolean; aiEntryPaused: boolean }>;

  async create(input: CreatePositionInput): Promise<PositionRecord> {
    const normalizedToken = getAddress(input.tokenAddress).toLowerCase() as Address;
    // P1-2 fix: mirrors the real repository's partial-unique-index
    // enforcement -- JS's single-threaded execution makes this
    // check-then-set genuinely atomic within this in-memory double (no
    // `await` between the check and the `.set()` below), the same
    // guarantee the real DB index provides across genuinely concurrent
    // processes.
    this.assertNoActiveDuplicate(normalizedToken);
    return this.insert(normalizedToken, input);
  }

  async createIfCapitalAllows(input: CreatePositionInput, readOnChainUsdgBalance: () => Promise<bigint>, rules: CapitalRules): Promise<CreateIfCapitalAllowsResult> {
    const normalizedToken = getAddress(input.tokenAddress).toLowerCase() as Address;
    // P1-1: mirrors the real repository's sequence exactly -- rows read
    // BEFORE the raw balance, then (after the balance await) a consistency
    // check + a fresh derivation via the SAME shared helpers. No `await`
    // between the fresh read and the insert, so the "under the lock" part
    // is genuinely atomic within this in-memory double.
    const observedBefore = new Map(this.nonClosedRows().map((r) => [r.id, r.status]));
    let onChainBalance: bigint;
    try {
      onChainBalance = await readOnChainUsdgBalance();
    } catch (err) {
      return { ok: false, reason: `capital reservation aborted (fail-closed): could not read the on-chain USDG balance: ${err instanceof Error ? err.message : String(err)}` };
    }
    // H2: exit legs of the CLOSING rows, read AFTER the balance (same order
    // as the real repository). Any status change during this await is
    // caught by the consistency check on the re-read below.
    const closePrefixes = this.nonClosedRows()
      .filter((r) => r.status === 'CLOSING' && r.closeIdempotencyKey)
      .map((r) => exitLegKeyPrefix(r.closeIdempotencyKey as string));
    const exitLegAttempts = this.txAttempts ? await this.txAttempts.findByKeyPrefixes(closePrefixes) : null;
    // Entry gate -- the LAST await: everything after it (checks + insert) is synchronous, i.e. "under the lock".
    const entry = this.entryGate ? await this.entryGate() : null;
    if (entry?.paused || entry?.aiEntryPaused) {
      const by = entry.paused ? ('OPERATOR' as const) : ('AI' as const);
      return { ok: false, reason: `entry paused (${by === 'AI' ? 'AI supervisor' : 'operator'}) -- no new position reserved`, entryPausedBy: by };
    }
    const freshRows = this.nonClosedRows();
    const consistency = checkCapitalStateConsistent(observedBefore, freshRows);
    if (!consistency.ok) {
      return { ok: false, reason: `capital reservation aborted (fail-closed, retry next cycle): ${consistency.reason}` };
    }

    const decision = decideCapitalAllocation(deriveCapitalSnapshot(onChainBalance, freshRows, exitLegAttempts), rules);
    if (!decision.ok) {
      return { ok: false, reason: `capital reservation conflict (re-checked at write time): ${decision.reason}` };
    }
    if (input.entryUsdgRaw > decision.positionSizeUsdgRaw) {
      return {
        ok: false,
        reason: `capital reservation conflict (re-checked at write time): a concurrent reservation reduced remaining capacity below the already-decided size (${input.entryUsdgRaw} > ${decision.positionSizeUsdgRaw} now available)`,
      };
    }
    this.assertNoActiveDuplicate(normalizedToken);
    return { ok: true, record: this.insert(normalizedToken, input) };
  }

  private nonClosedRows(): Array<{ id: string; status: string; entryUsdgRaw: bigint; closeIdempotencyKey: string | null }> {
    return [...this.byId.values()]
      .filter((p) => NON_CLOSED.has(p.status))
      .map((p) => ({ id: p.id, status: p.status, entryUsdgRaw: p.entryUsdgRaw, closeIdempotencyKey: p.closeIdempotencyKey }));
  }

  private assertNoActiveDuplicate(normalizedToken: Address): void {
    for (const existing of this.byId.values()) {
      if (existing.tokenAddress === normalizedToken && NON_CLOSED.has(existing.status)) {
        throw new DuplicateActiveTokenPositionError(normalizedToken);
      }
    }
  }

  private insert(normalizedToken: Address, input: CreatePositionInput): PositionRecord {
    const record: PositionRecord = {
      id: String(this.nextId++),
      tokenAddress: normalizedToken,
      tokenSymbol: input.tokenSymbol,
      tokenDecimals: input.tokenDecimals,
      pool: input.pool,
      tickLower: input.tickLower,
      tickUpper: input.tickUpper,
      positionTokenId: null,
      entryUsdgRaw: input.entryUsdgRaw,
      entrySqrtPriceX96: input.entrySqrtPriceX96,
      entryTick: input.entryTick,
      status: 'OPENING',
      openIdempotencyKey: input.openIdempotencyKey,
      closeIdempotencyKey: null,
      openedAt: null,
      closedAt: null,
      closeReason: null,
      realizedUsdgRaw: null,
    };
    this.byId.set(record.id, record);
    this.createdAt.set(record.id, new Date());
    return record;
  }

  async findById(id: string): Promise<PositionRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findActiveByToken(tokenAddress: Address): Promise<PositionRecord | null> {
    const normalized = getAddress(tokenAddress).toLowerCase();
    for (const record of this.byId.values()) {
      if (record.tokenAddress === normalized && NON_CLOSED.has(record.status)) {
        return record;
      }
    }
    return null;
  }

  async findAllActive(): Promise<PositionRecord[]> {
    return [...this.byId.values()].filter((r) => r.status === 'ACTIVE');
  }

  async findAllClosing(): Promise<PositionRecord[]> {
    return [...this.byId.values()].filter((r) => r.status === 'CLOSING');
  }

  async findAllOpening(): Promise<PositionRecord[]> {
    return [...this.byId.values()].filter((r) => r.status === 'OPENING');
  }

  async findAllClosed(): Promise<PositionRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.status === 'CLOSED')
      .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
  }

  async findDeployedPositions(): Promise<PositionRecord[]> {
    return [...this.byId.values()].filter((r) => NON_CLOSED.has(r.status));
  }

  async countNonClosed(): Promise<number> {
    return [...this.byId.values()].filter((r) => NON_CLOSED.has(r.status)).length;
  }

  // Stale-writer fix: lifecycle transitions mirror the real repository's
  // conditional UPDATEs -- `null` (nothing written) when the row is not in
  // the expected prior state.
  async markActive(id: string, positionTokenId: string, openedAt: Date): Promise<PositionRecord | null> {
    const record = this.get(id);
    if (record.status !== 'OPENING') return null;
    record.status = 'ACTIVE';
    record.positionTokenId = positionTokenId;
    record.openedAt = openedAt;
    return record;
  }

  async markClosing(id: string, closeIdempotencyKey: string): Promise<PositionRecord | null> {
    const record = this.get(id);
    if (record.status !== 'ACTIVE') return null;
    record.status = 'CLOSING';
    record.closeIdempotencyKey = closeIdempotencyKey;
    return record;
  }

  /** Manual TOKEN settlement via receipt: mirrors the `ManualTokenSettlement` table (txHash primary key). */
  readonly manualSettlements = new Map<string, ManualSettlementRecord>();
  readonly dustSettlements = new Map<string, DustSettlementRecord>();

  async markClosed(
    id: string,
    closedAt: Date,
    closeReason: string,
    realizedUsdgRaw?: bigint | null,
    expectedCloseIdempotencyKey?: string,
    manualSettlement?: ManualSettlementEvidence,
    dustSettlement?: DustSettlementEvidence,
  ): Promise<PositionRecord | null> {
    const record = this.get(id);
    if (record.status !== 'CLOSING') return null;
    if (expectedCloseIdempotencyKey !== undefined && record.closeIdempotencyKey !== expectedCloseIdempotencyKey) return null;
    const before = { ...record };
    record.status = 'CLOSED'; // claimed synchronously -- a concurrent call now sees CLOSED and returns null
    record.closedAt = closedAt;
    record.closeReason = closeReason;
    record.realizedUsdgRaw = realizedUsdgRaw !== undefined ? realizedUsdgRaw : null;
    try {
      await this.cooldown?.recordExit(record.tokenAddress, closedAt);
      if (manualSettlement) {
        if (this.manualSettlements.has(manualSettlement.txHash)) throw new ManualSettlementTxAlreadyUsedError(manualSettlement.txHash);
        this.manualSettlements.set(manualSettlement.txHash, { ...manualSettlement, positionId: id, closeIdempotencyKey: record.closeIdempotencyKey ?? '', settledAt: closedAt });
      }
      if (dustSettlement) {
        // primary key = positionId in the real table: a repeat can never write twice
        if (this.dustSettlements.has(id)) throw new Error(`dust settlement already recorded for position ${id}`);
        this.dustSettlements.set(id, { ...dustSettlement, positionId: id, closeIdempotencyKey: record.closeIdempotencyKey ?? '', settledAt: closedAt });
      }
    } catch (err) {
      Object.assign(record, before); // "transaction" rollback: not CLOSED, no proceeds
      throw err;
    }
    return record;
  }

  async findDustSettlementByPositionId(positionId: string): Promise<DustSettlementRecord | null> {
    const found = this.dustSettlements.get(positionId);
    return found ? { ...found } : null;
  }

  async findManualSettlementByTxHash(txHash: string): Promise<ManualSettlementRecord | null> {
    const found = this.manualSettlements.get(txHash.toLowerCase());
    return found ? { ...found } : null;
  }

  async backfillRealizedUsdgRaw(id: string, realizedUsdgRaw: bigint): Promise<PositionRecord | null> {
    const record = this.byId.get(id);
    if (!record || record.status !== 'CLOSED' || record.realizedUsdgRaw !== null) return null;
    record.realizedUsdgRaw = realizedUsdgRaw;
    return record;
  }

  async markFailed(id: string): Promise<PositionRecord | null> {
    const record = this.get(id);
    if (record.status !== 'OPENING') return null;
    record.status = 'FAILED';
    return record;
  }

  async markExitFailed(id: string, closeIdempotencyKey: string): Promise<PositionRecord | null> {
    const record = this.get(id);
    if (record.status !== 'CLOSING' || record.closeIdempotencyKey !== closeIdempotencyKey) return null;
    record.status = 'ACTIVE';
    record.closeIdempotencyKey = null;
    return record;
  }

  async claimForResume(id: string, expectedStatus: 'OPENING' | 'CLOSING', freshnessMs: number): Promise<string | null> {
    const record = this.byId.get(id);
    if (!record || record.status !== expectedStatus) return null;
    const now = Date.now();
    const lastClaim = this.claimedAt.get(id);
    if (lastClaim !== undefined && now - lastClaim < freshnessMs) return null;
    // P0-1: a fresh, unique-per-call token -- deliberately NOT crypto-random
    // (this is a synchronous, dependency-free test double), just guaranteed
    // unique within this instance's lifetime, which is all a single test
    // process needs.
    const token = `test-claim-${this.nextTokenSeq++}`;
    this.claimedAt.set(id, now);
    this.claimToken.set(id, token);
    return token;
  }

  async releaseResumeClaim(id: string, token: string): Promise<boolean> {
    // P0-1: mirrors the real repository's `WHERE resumeClaimToken = ?`
    // conditional release -- a stale caller whose token no longer matches
    // (claim expired and re-won by someone else, or already released) is a
    // safe no-op, never mutates the current owner's claim.
    if (this.claimToken.get(id) !== token) return false;
    this.claimedAt.delete(id);
    this.claimToken.delete(id);
    return true;
  }

  /** Test helper (H3): back-date a row's persisted creation time, as if it had been created at `at` (e.g. before a restart). */
  setCreatedAtForTest(id: string, at: Date): void {
    this.get(id);
    this.createdAt.set(id, at);
  }

  /**
   * H3: mirrors `PrismaPositionRepository.expireStaleOpening` -- same checks,
   * same fence (create the mint key FAILED, or version-CAS it to FAILED
   * while it is still before SIGNED), same conditional OPENING -> FAILED.
   * Requires the attempts repository this double was constructed with.
   */
  async expireStaleOpening(id: string, maxAgeMs: number, now: Date): Promise<OpeningExpiryResult> {
    // Mirrors the real repository's CapitalLock write-lock transaction: the
    // whole check-and-fence runs serialized, so a concurrent caller only
    // starts once the first has committed (and then sees NOT_OPENING).
    const run = this.expiryLock.then(() => this.expireStaleOpeningLocked(id, maxAgeMs, now));
    this.expiryLock = run.then(() => undefined, () => undefined);
    return run;
  }

  private expiryLock: Promise<void> = Promise.resolve();

  private async expireStaleOpeningLocked(id: string, maxAgeMs: number, now: Date): Promise<OpeningExpiryResult> {
    if (!this.txAttempts) throw new Error('InMemoryPositionRepository.expireStaleOpening needs the txAttempts repository (constructor argument)');
    const row = this.byId.get(id);
    if (!row || row.status !== 'OPENING') return { outcome: 'NOT_OPENING' };
    const ageMs = now.getTime() - (this.createdAt.get(id) ?? now).getTime();
    if (ageMs < maxAgeMs) return { outcome: 'TOO_YOUNG', ageMs };

    const mintKey = openMintAttemptKey(row.openIdempotencyKey);
    const mint = await this.txAttempts.find(mintKey);
    const approve = await this.txAttempts.find(`${row.openIdempotencyKey}:approve`);
    if (row.status !== 'OPENING') return { outcome: 'NOT_OPENING' }; // re-check after the await
    const lastError = `OPENING expired after ${ageMs}ms (max ${maxAgeMs}ms) with no broadcast mint -- reservation released`;
    const possiblyBroadcast = (s: string) => s === 'SIGNED' || s === 'SENT' || s === 'CONFIRMED';
    if (mint?.status === 'VERIFIED') return { outcome: 'MINT_VERIFIED' };
    if (mint && possiblyBroadcast(mint.status)) return { outcome: 'BLOCKED_UNRESOLVED_TX', mintStatus: mint.status };
    if (approve && possiblyBroadcast(approve.status)) return { outcome: 'BLOCKED_UNRESOLVED_TX', mintStatus: mint?.status ?? 'NONE', approveStatus: approve.status };
    if (approve && approve.status !== 'FAILED' && approve.status !== 'VERIFIED') {
      await this.txAttempts.update(approve.id, { status: 'FAILED', failureCode: 'OPENING_TIMEOUT', lastError: `OPENING expired after ${ageMs}ms (max ${maxAgeMs}ms) before this approve was signed -- fenced` }, approve.version);
    }
    if (mint === null) {
      const created = await this.txAttempts.create(mintKey, 'deploy:mint');
      await this.txAttempts.update(created.id, { status: 'FAILED', failureCode: 'OPENING_TIMEOUT', lastError }, created.version);
    } else if (mint.status !== 'FAILED') {
      await this.txAttempts.update(mint.id, { status: 'FAILED', failureCode: 'OPENING_TIMEOUT', lastError }, mint.version);
    }
    if (row.status !== 'OPENING') return { outcome: 'NOT_OPENING' };
    row.status = 'FAILED';
    return { outcome: 'EXPIRED', mintStatusBefore: mint?.status ?? null };
  }

  private get(id: string): PositionRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error(`no position with id ${id}`);
    return record;
  }
}

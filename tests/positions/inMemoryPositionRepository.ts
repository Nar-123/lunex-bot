import type { Address } from 'viem';
import { getAddress } from 'viem';
import type { CreateIfCapitalAllowsResult, CreatePositionInput, PositionRecord, PositionRepository } from '../../src/positions/types';
import { DuplicateActiveTokenPositionError } from '../../src/positions/types';
import { decideCapitalAllocation } from '../../src/capital/decideCapitalAllocation';
import type { CapitalRules } from '../../src/capital/types';
import { checkCapitalStateConsistent, deriveCapitalSnapshot } from '../../src/capital/freshCapitalSnapshot';

const NON_CLOSED = new Set(['OPENING', 'ACTIVE', 'CLOSING']);

/** In-memory test double, same role as the other modules' in-memory repos: fast, no DB, for testing logic built ON TOP of the repository interface. */
export class InMemoryPositionRepository implements PositionRepository {
  private byId = new Map<string, PositionRecord>();
  private claimedAt = new Map<string, number>();
  private claimToken = new Map<string, string>();
  private nextId = 1;
  private nextTokenSeq = 1;

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
    const freshRows = this.nonClosedRows();
    const consistency = checkCapitalStateConsistent(observedBefore, freshRows);
    if (!consistency.ok) {
      return { ok: false, reason: `capital reservation aborted (fail-closed, retry next cycle): ${consistency.reason}` };
    }

    const decision = decideCapitalAllocation(deriveCapitalSnapshot(onChainBalance, freshRows), rules);
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

  private nonClosedRows(): Array<{ id: string; status: string; entryUsdgRaw: bigint }> {
    return [...this.byId.values()].filter((p) => NON_CLOSED.has(p.status)).map((p) => ({ id: p.id, status: p.status, entryUsdgRaw: p.entryUsdgRaw }));
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

  async markActive(id: string, positionTokenId: string, openedAt: Date): Promise<PositionRecord> {
    const record = this.get(id);
    record.status = 'ACTIVE';
    record.positionTokenId = positionTokenId;
    record.openedAt = openedAt;
    return record;
  }

  async markClosing(id: string, closeIdempotencyKey: string): Promise<PositionRecord> {
    const record = this.get(id);
    record.status = 'CLOSING';
    record.closeIdempotencyKey = closeIdempotencyKey;
    return record;
  }

  async markClosed(id: string, closedAt: Date, closeReason: string, realizedUsdgRaw?: bigint | null): Promise<PositionRecord> {
    const record = this.get(id);
    record.status = 'CLOSED';
    record.closedAt = closedAt;
    record.closeReason = closeReason;
    record.realizedUsdgRaw = realizedUsdgRaw !== undefined ? realizedUsdgRaw : null;
    return record;
  }

  async backfillRealizedUsdgRaw(id: string, realizedUsdgRaw: bigint): Promise<PositionRecord | null> {
    const record = this.byId.get(id);
    if (!record || record.status !== 'CLOSED' || record.realizedUsdgRaw !== null) return null;
    record.realizedUsdgRaw = realizedUsdgRaw;
    return record;
  }

  async markFailed(id: string): Promise<PositionRecord> {
    const record = this.get(id);
    record.status = 'FAILED';
    return record;
  }

  async markExitFailed(id: string): Promise<PositionRecord> {
    const record = this.get(id);
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

  private get(id: string): PositionRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error(`no position with id ${id}`);
    return record;
  }
}

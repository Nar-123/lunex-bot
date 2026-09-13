import type { Address } from 'viem';
import { getAddress } from 'viem';
import type { CreatePositionInput, PositionRecord, PositionRepository } from '../../src/positions/types';

const NON_CLOSED = new Set(['OPENING', 'ACTIVE', 'CLOSING']);

/** In-memory test double, same role as the other modules' in-memory repos: fast, no DB, for testing logic built ON TOP of the repository interface. */
export class InMemoryPositionRepository implements PositionRepository {
  private byId = new Map<string, PositionRecord>();
  private claimedAt = new Map<string, number>();
  private nextId = 1;

  async create(input: CreatePositionInput): Promise<PositionRecord> {
    const record: PositionRecord = {
      id: String(this.nextId++),
      tokenAddress: getAddress(input.tokenAddress).toLowerCase() as Address,
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

  async claimForResume(id: string, expectedStatus: 'OPENING' | 'CLOSING', freshnessMs: number): Promise<boolean> {
    const record = this.byId.get(id);
    if (!record || record.status !== expectedStatus) return false;
    const now = Date.now();
    const lastClaim = this.claimedAt.get(id);
    if (lastClaim !== undefined && now - lastClaim < freshnessMs) return false;
    this.claimedAt.set(id, now);
    return true;
  }

  async releaseResumeClaim(id: string): Promise<void> {
    this.claimedAt.delete(id);
  }

  private get(id: string): PositionRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error(`no position with id ${id}`);
    return record;
  }
}

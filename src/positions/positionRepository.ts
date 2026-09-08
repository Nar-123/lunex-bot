import { getAddress } from 'viem';
import type { Address } from 'viem';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../storage/prismaClient';
import type { CreatePositionInput, PositionRecord, PositionRepository, PositionStatus } from './types';

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
}

function normalizeAddress(address: string): Address {
  return getAddress(address).toLowerCase() as Address;
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
  };
}

/** Any status other than CLOSED still occupies the token's "1 coin = 1 position" slot. */
const NON_CLOSED_STATUSES = ['OPENING', 'ACTIVE', 'CLOSING'];

export class PrismaPositionRepository implements PositionRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  async create(input: CreatePositionInput): Promise<PositionRecord> {
    const row = await this.prisma.position.create({
      data: {
        tokenAddress: normalizeAddress(input.tokenAddress),
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
    const rows = await this.prisma.position.findMany({ where: { status: 'OPENING' } });
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

  async markClosed(id: string, closedAt: Date, closeReason: string): Promise<PositionRecord> {
    const row = await this.prisma.position.update({
      where: { id },
      data: { status: 'CLOSED', closedAt, closeReason },
    });
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
}

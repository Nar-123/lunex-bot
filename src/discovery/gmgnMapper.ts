import { z } from 'zod';
import type { AssetType, CandidateToken } from './types';
import { sanitizeDisplayText } from './sanitize';

/**
 * Field names below (`market_cap`, `top_10_holder_rate`, `gas_fee`) are
 * GMGN's actual `market trending` response fields, confirmed against
 * GMGN production integration code -- not a guess. Two unit notes that
 * matter a lot for correctness:
 *
 *  - `gas_fee` is the ALL-TIME TOTAL FEE metric the spec requires
 *    (`>= 0.5 ETH`), but it is denominated in the chain's NATIVE GAS
 *    CURRENCY (ETH, for Robinhood Chain) -- NOT USD. Never treat this
 *    value as a USD figure anywhere downstream.
 *  - `top_10_holder_rate` is already a 0..1 fraction (0.4 = 40%), matching
 *    what `filters/rules/holderConcentration.ts` expects directly.
 *
 * `market trending` does NOT include token age at all -- see
 * `gmgnTokenInfoSchema` / `parseTokenInfo` below, fetched via a separate
 * per-candidate `token info` call in `gmgnCliClient.ts`.
 *
 * A stricter, separate CLI/API filter flag exists for fee
 * (`--min-gas-fee`), and a *different* flag (`--min-total-fee`) exists
 * only on the unrelated `trenches` endpoint -- we don't use either at
 * fetch time; `filters/rules/totalFee.ts` applies the spec's threshold
 * client-side so the business threshold lives in exactly one place
 * (`config.rules.filters`), not duplicated into a query parameter too.
 */
export const gmgnTrendingTokenSchema = z
  .object({
    address: z.string().min(1),
    symbol: z.string().min(1),
    name: z.string().min(1),
    market_cap: z.number(),
    volume_usd: z.number(),
    gas_fee: z.number(), // native chain currency (ETH on Robinhood Chain) -- NOT USD
    top_10_holder_rate: z.number().min(0).max(1),
    asset_type: z.string(),
  })
  .loose();

export type GmgnTrendingToken = z.infer<typeof gmgnTrendingTokenSchema>;

const gmgnTrendingResponseSchema = z.object({
  data: z.array(gmgnTrendingTokenSchema),
});

/**
 * `token info` response, used only to fill in the age (`market trending`
 * doesn't carry it). `creation_timestamp` is Unix SECONDS -- a different
 * unit than `CandidateToken.createdAt`, which is epoch MILLISECONDS.
 */
export const gmgnTokenInfoSchema = z
  .object({
    address: z.string().min(1),
    creation_timestamp: z.number(),
  })
  .loose();

export type GmgnTokenInfo = z.infer<typeof gmgnTokenInfoSchema>;

const ASSET_TYPE_ALIASES: Record<string, AssetType> = {
  meme: 'Meme',
  memecoin: 'Meme',
  project: 'Project',
  stock: 'Stock',
  etf: 'ETF',
  index: 'Index',
  rwa: 'RWA',
  'real world asset': 'RWA',
  'tokenized equity': 'Tokenized Equity',
  'tokenized stock': 'Tokenized Equity',
  'wrapped stock': 'Wrapped Stock',
};

/**
 * Normalizes a raw asset-type string to our closed `AssetType` union.
 * Anything unrecognized maps to `'Unknown'`, which is on the rejected
 * list -- an unrecognized category is refused by default rather than
 * accidentally treated as tradeable.
 */
export function normalizeAssetType(raw: string): AssetType {
  return ASSET_TYPE_ALIASES[raw.trim().toLowerCase()] ?? 'Unknown';
}

/** Schema/shape violation in a GMGN response -- never silently collapse to an empty result for this. */
export class GmgnMappingError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'GmgnMappingError';
  }
}

export interface MapContext {
  chainId: number;
  discoveredAt: number;
}

/** A candidate assembled from `market trending` alone -- age is not yet known. */
export type PartialCandidate = Omit<CandidateToken, 'createdAt'>;

export function mapTrendingToken(raw: GmgnTrendingToken, rank: number, ctx: MapContext): PartialCandidate {
  return {
    address: raw.address,
    chainId: ctx.chainId,
    symbol: sanitizeDisplayText(raw.symbol, 32),
    name: sanitizeDisplayText(raw.name, 64),
    assetType: normalizeAssetType(raw.asset_type),
    marketCapUsd: raw.market_cap,
    volumeUsd: raw.volume_usd,
    totalFeeEth: raw.gas_fee,
    top10HolderConcentrationPct: raw.top_10_holder_rate,
    rank,
    discoveredAt: ctx.discoveredAt,
    source: 'GMGN',
    raw,
  };
}

/**
 * Parses + validates a raw `market trending` response and maps every
 * entry to a `PartialCandidate` (no `createdAt` yet). Throws
 * `GmgnMappingError` on any schema mismatch -- callers must propagate
 * this, never treat it as "zero candidates today".
 */
export function mapTrendingResponseToPartialCandidates(body: unknown, ctx: MapContext): PartialCandidate[] {
  const parsed = gmgnTrendingResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new GmgnMappingError(
      `GMGN market-trending response did not match the expected shape: ${parsed.error.message}`,
      parsed.error,
    );
  }
  return parsed.data.data.map((raw, i) => mapTrendingToken(raw, i + 1, ctx));
}

/** Parses + validates a raw `token info` response. Throws `GmgnMappingError` on mismatch. */
export function parseTokenInfo(body: unknown): GmgnTokenInfo {
  const parsed = gmgnTokenInfoSchema.safeParse(body);
  if (!parsed.success) {
    throw new GmgnMappingError(
      `GMGN token-info response did not match the expected shape: ${parsed.error.message}`,
      parsed.error,
    );
  }
  return parsed.data;
}

/** Merges a `token info` lookup into a partial candidate, converting seconds -> ms. */
export function mergeCreatedAt(partial: PartialCandidate, tokenInfo: GmgnTokenInfo): CandidateToken {
  return {
    ...partial,
    createdAt: tokenInfo.creation_timestamp * 1000,
  };
}

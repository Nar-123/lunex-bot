import { z } from 'zod';
import type { AssetType, CandidateToken } from './types';
import { sanitizeDisplayText } from './sanitize';

/**
 * Field names below are official gmgn-cli 1.6.2 `market trending --raw`
 * output, captured LIVE against the real GMGN OpenAPI on Robinhood Chain
 * (chain=robinhood, interval=6h) on 2026-09-14 -- fixture:
 * `tests/discovery/fixtures/gmgn_trending.json`. The CLI unwraps the API's
 * `{code, message, data}` envelope server-side only for `code !== 0`
 * (which exits non-zero); on success stdout is the envelope itself:
 * `{code: 0, message: "success", reason: "", data: {rank: [...]}}`.
 *
 * Three field corrections versus the old (pre-live-verification)
 * assumption, all verified against every entry of the live capture:
 *  - the volume field is `volume` (USD, for the queried interval) -- there
 *    is no `volume_usd` field in the response at all;
 *  - there is NO `asset_type` field anywhere in trending output -- the
 *    asset-type signal must come from elsewhere (see `normalizeAssetType`'s
 *    new doc comment);
 *  - `gas_fee` IS present and is the all-time total fee in the chain's
 *    NATIVE GAS CURRENCY (ETH on Robinhood Chain) -- NOT USD, and NOT a
 *    per-transaction average: live cross-check, trending's `gas_fee`
 *    488.535 for PONS equals `token info`'s `total_fee` "488.537..." to
 *    rounding, i.e. the same all-time total fee quantity. Never treat this
 *    value as USD anywhere downstream.
 *
 * `market trending` does NOT include token age at all -- see
 * `gmgnTokenInfoSchema` / `parseTokenInfo` below, fetched via a separate
 * per-candidate `token info` call in `gmgnCliClient.ts`.
 *
 * A stricter, separate CLI/API filter flag exists for fee
 * (`--min-gas-fee`); we don't use it at fetch time;
 * `filters/rules/totalFee.ts` applies the spec's threshold client-side so
 * the business threshold lives in exactly one place
 * (`config.rules.filters`), not duplicated into a query parameter too.
 */
export const gmgnTrendingTokenSchema = z
  .object({
    address: z.string().min(1),
    symbol: z.string().min(1),
    name: z.string().min(1),
    market_cap: z.number(),
    volume: z.number(),
    gas_fee: z.number(), // native chain currency (ETH on Robinhood Chain) -- NOT USD
    top_10_holder_rate: z.number().min(0).max(1),
  })
  .loose();

export type GmgnTrendingToken = z.infer<typeof gmgnTrendingTokenSchema>;

const gmgnTrendingResponseSchema = z.object({
  code: z.number(),
  data: z.object({
    rank: z.array(gmgnTrendingTokenSchema),
  }),
});

/**
 * `token info --raw` response (same live capture, same date -- fixture:
 * `tests/discovery/fixtures/gmgn_tokeninfo.json`). Unlike trending, stdout
 * here has NO envelope: top-level fields directly (address, symbol, name,
 * creation_timestamp, ...). `creation_timestamp` is Unix SECONDS -- a
 * different unit than `CandidateToken.createdAt`, which is epoch
 * MILLISECONDS.
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
 *
 * LIVE-VERIFICATION NOTE: official gmgn-cli 1.6.2 `market trending` output
 * carries NO asset-type field at all (checked across every field of all 10
 * live entries -- no `asset_type`, `category`, or equivalent exists), so
 * `mapTrendingToken` now always feeds this function `undefined` and every
 * trending-discovered candidate maps to `'Unknown'`, which the ASSET_TYPE
 * filter REJECTS by design. This is the deliberate fail-safe resolution of
 * "the data source no longer supplies the field": the ASSET_TYPE filter
 * stays intact (strategy rule, out of scope for the integration fix) and
 * the candidate pipeline stays closed until an operator decision on the
 * spec's asset-type requirement is made. The alias table is kept because
 * the field may return in a future CLI version or via `token info`'s
 * richer payload -- mapping a real value again is then a one-line change
 * in `mapTrendingToken`.
 */
export function normalizeAssetType(raw: string | undefined): AssetType {
  return ASSET_TYPE_ALIASES[(raw ?? '').trim().toLowerCase()] ?? 'Unknown';
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
    assetType: normalizeAssetType(undefined),
    marketCapUsd: raw.market_cap,
    volumeUsd: raw.volume,
    totalFeeEth: raw.gas_fee,
    top10HolderConcentrationPct: raw.top_10_holder_rate,
    rank,
    discoveredAt: ctx.discoveredAt,
    source: 'GMGN',
    raw,
  };
}

/**
 * Parses + validates a raw `market trending` response and maps every entry
 * to a `PartialCandidate` (no `createdAt` yet). Throws `GmgnMappingError`
 * on any schema mismatch -- callers must propagate this, never treat it as
 * "zero candidates today".
 */
export function mapTrendingResponseToPartialCandidates(body: unknown, ctx: MapContext): PartialCandidate[] {
  const parsed = gmgnTrendingResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new GmgnMappingError(
      `GMGN market-trending response did not match the expected shape: ${parsed.error.message}`,
      parsed.error,
    );
  }
  return parsed.data.data.rank.map((raw, i) => mapTrendingToken(raw, i + 1, ctx));
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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mapTrendingResponseToPartialCandidates,
  mapTrendingToken,
  parseTokenInfo,
  mergeCreatedAt,
  normalizeAssetType,
  GmgnMappingError,
} from '../../src/discovery/gmgnMapper';

const ctx = { chainId: 1337, discoveredAt: 1_700_000_000_000 };

/**
 * Live-captured official gmgn-cli 1.6.2 output (2026-09-14):
 * `market trending --chain robinhood --interval 6h --limit 10 --raw` and
 * `token info --chain robinhood --address <PONS> --raw`. These fixtures
 * ARE the schema contract -- if GMGN renames a field, these tests fail
 * before anything silently mis-parses.
 */
const liveTrending = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/gmgn_trending.json'), 'utf-8')) as unknown;
const liveTokenInfo = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/gmgn_tokeninfo.json'), 'utf-8')) as unknown;

function rawTrendingToken(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    address: '0xabc',
    symbol: 'FOO',
    name: 'Foo Token',
    market_cap: 2_000_000,
    volume: 100_000,
    gas_fee: 1.2, // native chain currency (ETH), not USD
    top_10_holder_rate: 0.15,
    ...overrides,
  };
}

function trendingBody(rank: Array<Record<string, unknown>>) {
  // The CLI's success envelope, as captured live: {code, message, reason, data: {rank}}.
  return { code: 0, message: 'success', reason: '', data: { rank } };
}

describe('normalizeAssetType', () => {
  it('maps known aliases case-insensitively', () => {
    expect(normalizeAssetType('Meme')).toBe('Meme');
    expect(normalizeAssetType('MEMECOIN')).toBe('Meme');
    expect(normalizeAssetType('project')).toBe('Project');
    expect(normalizeAssetType('Tokenized Stock')).toBe('Tokenized Equity');
  });

  it('falls back to Unknown for anything unrecognized (safe-by-default: rejected)', () => {
    expect(normalizeAssetType('something-new-gmgn-invented')).toBe('Unknown');
    expect(normalizeAssetType('')).toBe('Unknown');
  });

  it('returns Unknown when the field is absent -- live trending output has no asset-type field at all', () => {
    expect(normalizeAssetType(undefined)).toBe('Unknown');
  });
});

describe('mapTrendingToken', () => {
  it('maps a valid raw token to a normalized partial candidate (no createdAt yet)', () => {
    const raw = rawTrendingToken();
    const candidate = mapTrendingToken(raw as never, 3, ctx);
    expect(candidate).toMatchObject({
      address: '0xabc',
      chainId: 1337,
      symbol: 'FOO',
      marketCapUsd: 2_000_000,
      volumeUsd: 100_000,
      totalFeeEth: 1.2, // mapped from gas_fee, native currency
      top10HolderConcentrationPct: 0.15,
      rank: 3,
      discoveredAt: ctx.discoveredAt,
      source: 'GMGN',
    });
    expect(candidate).not.toHaveProperty('createdAt');
  });

  it('maps trending candidates with no asset-type field to assetType "Unknown" (rejected by ASSET_TYPE filter)', () => {
    // Live-verified: gmgn-cli 1.6.2 trending output has no asset_type field.
    const candidate = mapTrendingToken(rawTrendingToken() as never, 1, ctx);
    expect(candidate.assetType).toBe('Unknown');
  });

  it('sanitizes attacker-controlled symbol/name before they ever reach a CandidateToken', () => {
    const raw = rawTrendingToken({ symbol: 'EVIL*_`[x]', name: '<script>alert(1)</script>' });
    const candidate = mapTrendingToken(raw as never, 1, ctx);
    expect(candidate.symbol).not.toMatch(/[*_`[\]]/);
    expect(candidate.name).not.toMatch(/[<>]/);
  });
});

describe('mapTrendingResponseToPartialCandidates', () => {
  it('parses a well-formed response into ranked partial candidates', () => {
    const body = trendingBody([rawTrendingToken({ symbol: 'A' }), rawTrendingToken({ symbol: 'B' })]);
    const candidates = mapTrendingResponseToPartialCandidates(body, ctx);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.rank).toBe(1);
    expect(candidates[1]?.rank).toBe(2);
  });

  it('maps the LIVE-captured robinhood 6h trending fixture end to end', () => {
    const candidates = mapTrendingResponseToPartialCandidates(liveTrending, ctx);
    expect(candidates).toHaveLength(10);
    // PONS, rank 1 in the capture: {market_cap: 557829000, volume: 15312400,
    // gas_fee: ~488.54 ETH, top_10_holder_rate: 0.1206}
    expect(candidates[0]).toMatchObject({
      symbol: 'PONS',
      address: '0x39dbed3a2bd333467115de45665cc57f813c4571',
      marketCapUsd: 557_829_000,
      volumeUsd: 15_312_400,
      top10HolderConcentrationPct: 0.1206,
      assetType: 'Unknown', // no asset_type field in live trending output
    });
    expect(candidates[0]?.totalFeeEth).toBeCloseTo(488.535, 2);
  });

  it('throws GmgnMappingError instead of silently defaulting a missing financial field', () => {
    const body = trendingBody([rawTrendingToken({ market_cap: undefined })]);
    expect(() => mapTrendingResponseToPartialCandidates(body, ctx)).toThrow(GmgnMappingError);
  });

  it('throws when the top-level response shape is unexpected (never collapses to [])', () => {
    expect(() => mapTrendingResponseToPartialCandidates({ items: [] }, ctx)).toThrow(GmgnMappingError);
    expect(() => mapTrendingResponseToPartialCandidates(null, ctx)).toThrow(GmgnMappingError);
  });

  it('throws when data.rank is missing -- the old pre-envelope {data: [...]} shape is now malformed', () => {
    // Regression guard for the schema fix itself: a response in the old
    // assumed shape ({data: [...]}, no rank key) must fail loudly, not
    // silently parse zero candidates.
    expect(() => mapTrendingResponseToPartialCandidates({ data: [rawTrendingToken()] }, ctx)).toThrow(GmgnMappingError);
  });

  it('accepts a genuinely empty but well-formed candidate list', () => {
    const candidates = mapTrendingResponseToPartialCandidates(trendingBody([]), ctx);
    expect(candidates).toEqual([]);
  });

  it('throws when holder concentration is outside the 0..1 fraction range', () => {
    const body = trendingBody([rawTrendingToken({ top_10_holder_rate: 40 })]); // looks like "40" meant as percent, not fraction
    expect(() => mapTrendingResponseToPartialCandidates(body, ctx)).toThrow(GmgnMappingError);
  });
});

describe('parseTokenInfo / mergeCreatedAt', () => {
  it('parses token info and converts creation_timestamp from seconds to milliseconds', () => {
    const info = parseTokenInfo({ address: '0xabc', creation_timestamp: 1_699_000_000 });
    expect(info.creation_timestamp).toBe(1_699_000_000);

    const partial = mapTrendingToken(rawTrendingToken() as never, 1, ctx);
    const full = mergeCreatedAt(partial, info);
    expect(full.createdAt).toBe(1_699_000_000 * 1000);
  });

  it('parses the LIVE-captured token info fixture (top-level fields, no envelope)', () => {
    const info = parseTokenInfo(liveTokenInfo);
    expect(info.address).toBe('0x39dbed3a2bd333467115de45665cc57f813c4571');
    expect(info.creation_timestamp).toBe(1_783_975_341); // PONS, 2026-07-13, Unix seconds
  });

  it('throws GmgnMappingError on a malformed token-info response', () => {
    expect(() => parseTokenInfo({ address: '0xabc' })).toThrow(GmgnMappingError);
    expect(() => parseTokenInfo(null)).toThrow(GmgnMappingError);
    // The trending envelope shape is NOT a valid token-info response.
    expect(() => parseTokenInfo(trendingBody([]))).toThrow(GmgnMappingError);
  });
});

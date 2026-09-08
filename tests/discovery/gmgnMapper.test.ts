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

function rawTrendingToken(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    address: '0xabc',
    symbol: 'FOO',
    name: 'Foo Token',
    market_cap: 2_000_000,
    volume_usd: 100_000,
    gas_fee: 1.2, // native chain currency (ETH), not USD
    top_10_holder_rate: 0.15,
    asset_type: 'meme',
    ...overrides,
  };
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
});

describe('mapTrendingToken', () => {
  it('maps a valid raw token to a normalized partial candidate (no createdAt yet)', () => {
    const raw = rawTrendingToken();
    const candidate = mapTrendingToken(raw as never, 3, ctx);
    expect(candidate).toMatchObject({
      address: '0xabc',
      chainId: 1337,
      symbol: 'FOO',
      assetType: 'Meme',
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

  it('sanitizes attacker-controlled symbol/name before they ever reach a CandidateToken', () => {
    const raw = rawTrendingToken({ symbol: 'EVIL*_`[x]', name: '<script>alert(1)</script>' });
    const candidate = mapTrendingToken(raw as never, 1, ctx);
    expect(candidate.symbol).not.toMatch(/[*_`[\]]/);
    expect(candidate.name).not.toMatch(/[<>]/);
  });
});

describe('mapTrendingResponseToPartialCandidates', () => {
  it('parses a well-formed response into ranked partial candidates', () => {
    const body = { data: [rawTrendingToken({ symbol: 'A' }), rawTrendingToken({ symbol: 'B' })] };
    const candidates = mapTrendingResponseToPartialCandidates(body, ctx);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.rank).toBe(1);
    expect(candidates[1]?.rank).toBe(2);
  });

  it('throws GmgnMappingError instead of silently defaulting a missing financial field', () => {
    const body = { data: [rawTrendingToken({ market_cap: undefined })] };
    expect(() => mapTrendingResponseToPartialCandidates(body, ctx)).toThrow(GmgnMappingError);
  });

  it('throws when the top-level response shape is unexpected (never collapses to [])', () => {
    expect(() => mapTrendingResponseToPartialCandidates({ items: [] }, ctx)).toThrow(GmgnMappingError);
    expect(() => mapTrendingResponseToPartialCandidates(null, ctx)).toThrow(GmgnMappingError);
  });

  it('accepts a genuinely empty but well-formed candidate list', () => {
    const candidates = mapTrendingResponseToPartialCandidates({ data: [] }, ctx);
    expect(candidates).toEqual([]);
  });

  it('throws when holder concentration is outside the 0..1 fraction range', () => {
    const body = { data: [rawTrendingToken({ top_10_holder_rate: 40 })] }; // looks like "40" meant as percent, not fraction
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

  it('throws GmgnMappingError on a malformed token-info response', () => {
    expect(() => parseTokenInfo({ address: '0xabc' })).toThrow(GmgnMappingError);
    expect(() => parseTokenInfo(null)).toThrow(GmgnMappingError);
  });
});

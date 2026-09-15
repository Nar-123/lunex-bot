import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { classifyShadow, buildShadowReport, classifyShadowMultiSource, verifyAddressBinding } from '../../src/discovery/shadowAssetClassifier';
import type { PositiveSourceSignal, NamedSourceSignal } from '../../src/discovery/shadowAssetClassifier';
import { screenCandidates, getPassingCandidates } from '../../src/filters/screenCandidate';
import { makeCandidateToken } from '../fixtures/candidateToken';
import { config } from '../../src/config';

const ADDR_A = getAddress('0x1111111111111111111111111111111111111111');
const NO_SIGNAL: PositiveSourceSignal = { meme: null, project: null };

describe('classifyShadow -- precedence (Part E)', () => {
  it('1. authoritative Stock -> STOCK', () => {
    const result = classifyShadow({ tokenAddress: ADDR_A, chainId: 4663, stockClassification: 'ROBINHOOD_OFFICIAL_STOCK', positiveSources: NO_SIGNAL });
    expect(result.shadowAssetType).toBe('STOCK');
    expect(result.conflict).toBe(false);
  });

  it('2. authoritative Meme -> MEME', () => {
    const result = classifyShadow({ tokenAddress: ADDR_A, chainId: 4663, stockClassification: 'NON_STOCK', positiveSources: { meme: true, project: null } });
    expect(result.shadowAssetType).toBe('MEME');
    expect(result.conflict).toBe(false);
  });

  it('3. authoritative Project -> PROJECT', () => {
    const result = classifyShadow({ tokenAddress: ADDR_A, chainId: 4663, stockClassification: 'NON_STOCK', positiveSources: { meme: null, project: true } });
    expect(result.shadowAssetType).toBe('PROJECT');
    expect(result.conflict).toBe(false);
  });

  it('4. no source -> UNKNOWN (absence of coverage is never a negative classification)', () => {
    const result = classifyShadow({ tokenAddress: ADDR_A, chainId: 4663, stockClassification: 'NON_STOCK', positiveSources: NO_SIGNAL });
    expect(result.shadowAssetType).toBe('UNKNOWN');
    expect(result.conflict).toBe(false);
  });

  it('4b. UNKNOWN stock classification (RPC failure) + no positive source -> UNKNOWN, never treated as a pass', () => {
    const result = classifyShadow({ tokenAddress: ADDR_A, chainId: 4663, stockClassification: 'UNKNOWN', positiveSources: NO_SIGNAL });
    expect(result.shadowAssetType).toBe('UNKNOWN');
  });

  it('4c. a source that explicitly checked and found NOT meme/project (false, not null) still yields UNKNOWN, not a negative type', () => {
    const result = classifyShadow({ tokenAddress: ADDR_A, chainId: 4663, stockClassification: 'NON_STOCK', positiveSources: { meme: false, project: false } });
    expect(result.shadowAssetType).toBe('UNKNOWN');
    expect(result.conflict).toBe(false);
  });

  it('5. Stock overrides a lower-priority positive source, but the disagreement is surfaced as a conflict, not silently dropped', () => {
    const result = classifyShadow({ tokenAddress: ADDR_A, chainId: 4663, stockClassification: 'ROBINHOOD_OFFICIAL_STOCK', positiveSources: { meme: true, project: null } });
    expect(result.shadowAssetType).toBe('STOCK');
    expect(result.conflict).toBe(true);
    expect(result.conflictDetail).toBeDefined();
  });

  it('6. conflicting sources (both Meme AND Project positively confirmed) -> explicit conflict, UNKNOWN, no invented tie-breaker', () => {
    const result = classifyShadow({ tokenAddress: ADDR_A, chainId: 4663, stockClassification: 'NON_STOCK', positiveSources: { meme: true, project: true } });
    expect(result.shadowAssetType).toBe('UNKNOWN');
    expect(result.conflict).toBe(true);
    expect(result.conflictDetail).toMatch(/ambiguous/i);
  });

  it('7. token identity uses chain + contract address -- the function signature carries no symbol/name field at all', () => {
    const input = { tokenAddress: ADDR_A, chainId: 4663, stockClassification: 'NON_STOCK' as const, positiveSources: { meme: true, project: null } };
    // TypeScript itself enforces this: ShadowClassificationInput has no `symbol`/`name` field,
    // so it is structurally impossible for classifyShadow to branch on either.
    const result = classifyShadow(input);
    expect(result.tokenAddress).toBe(ADDR_A);
    expect(result.chainId).toBe(4663);
  });

  it('8. symbol mismatch does not change identity -- buildShadowReport keeps symbol purely as a display field, never part of the decision', () => {
    const rowsSameAddressDifferentSymbol = buildShadowReport(
      [
        { symbol: 'REAL_NAME', tokenAddress: ADDR_A, chainId: 4663, stockClassification: 'NON_STOCK', positiveSources: { meme: true, project: null }, currentProductionAssetType: 'Unknown' },
        { symbol: 'IMPOSTOR_CLAIMING_SAME_TOKEN', tokenAddress: ADDR_A, chainId: 4663, stockClassification: 'NON_STOCK', positiveSources: { meme: true, project: null }, currentProductionAssetType: 'Unknown' },
      ],
      ['Meme', 'Project'],
    );
    expect(rowsSameAddressDifferentSymbol[0]?.shadowAssetType).toBe(rowsSameAddressDifferentSymbol[1]?.shadowAssetType);
    expect(rowsSameAddressDifferentSymbol[0]?.shadowAssetType).toBe('MEME');
  });

  it('9. Uniswap V4 non-stock token (real TWINE on-chain result) != Stock, even though it trades through the real PoolManager', () => {
    // TWINE (0xe27501d787d647cc82a5b4a7eafd5750386f1b77) was independently
    // verified on-chain (Phase 9/11 live RPC read) to have NO EIP-1967
    // beacon slot set at all -> NON_STOCK -- confirmed regardless of the
    // fact that its GMGN `exchange` field is the real Uniswap V4
    // PoolManager address. This test locks that real, address-verified
    // result into the shadow classifier's own behavior.
    const result = classifyShadow({
      tokenAddress: getAddress('0xe27501d787d647cc82a5b4a7eafd5750386f1b77'),
      chainId: 4663,
      stockClassification: 'NON_STOCK',
      positiveSources: NO_SIGNAL,
    });
    expect(result.shadowAssetType).not.toBe('STOCK');
  });
});

const COINGECKO: Omit<NamedSourceSignal, 'meme' | 'project'> = { sourceName: 'CoinGecko', quality: 'MODERATE' };
const CMC: Omit<NamedSourceSignal, 'meme' | 'project'> = { sourceName: 'CoinMarketCap', quality: 'MODERATE' };
const STOCK_CLASSIFIER: Omit<NamedSourceSignal, 'meme' | 'project'> = { sourceName: 'OnChainStockClassifier', quality: 'AUTHORITATIVE' };

describe('classifyShadowMultiSource -- Phase 11B multi-source precedence (Part D)', () => {
  it('source positive -> correct class: a single AUTHORITATIVE-quality positive source is enough to reach MEME', () => {
    const result = classifyShadowMultiSource({
      tokenAddress: ADDR_A,
      chainId: 4663,
      stockClassification: 'NON_STOCK',
      sources: [{ ...STOCK_CLASSIFIER, meme: true, project: null }],
    });
    expect(result.shadowAssetType).toBe('MEME');
  });

  it('no source -> UNKNOWN', () => {
    const result = classifyShadowMultiSource({
      tokenAddress: ADDR_A,
      chainId: 4663,
      stockClassification: 'NON_STOCK',
      sources: [{ ...COINGECKO, meme: null, project: null }, { ...CMC, meme: null, project: null }],
    });
    expect(result.shadowAssetType).toBe('UNKNOWN');
    expect(result.memeSourceCount).toBe(0);
  });

  it('conflict (meme AND project both positively confirmed) -> UNKNOWN/CONFLICT, never a silent pick', () => {
    const result = classifyShadowMultiSource({
      tokenAddress: ADDR_A,
      chainId: 4663,
      stockClassification: 'NON_STOCK',
      sources: [{ ...COINGECKO, meme: true, project: null }, { ...CMC, meme: null, project: true }],
    });
    expect(result.shadowAssetType).toBe('UNKNOWN');
    expect(result.conflict).toBe(true);
  });

  it('Stock precedence preserved: on-chain STOCK wins even against two corroborating positive Meme sources, conflict surfaced not hidden', () => {
    const result = classifyShadowMultiSource({
      tokenAddress: ADDR_A,
      chainId: 4663,
      stockClassification: 'ROBINHOOD_OFFICIAL_STOCK',
      sources: [{ ...COINGECKO, meme: true, project: null }, { ...CMC, meme: true, project: null }],
    });
    expect(result.shadowAssetType).toBe('STOCK');
    expect(result.conflict).toBe(true);
  });

  it('address identity preserved: result always echoes back the exact input tokenAddress/chainId', () => {
    const result = classifyShadowMultiSource({ tokenAddress: ADDR_A, chainId: 4663, stockClassification: 'NON_STOCK', sources: [] });
    expect(result.tokenAddress).toBe(ADDR_A);
    expect(result.chainId).toBe(4663);
  });

  it('two independent MODERATE sources both positively confirming Meme -> MEME (corroboration, Part D rule 2)', () => {
    const result = classifyShadowMultiSource({
      tokenAddress: ADDR_A,
      chainId: 4663,
      stockClassification: 'NON_STOCK',
      sources: [{ ...COINGECKO, meme: true, project: null }, { ...CMC, meme: true, project: null }],
    });
    expect(result.shadowAssetType).toBe('MEME');
    expect(result.memeSourceCount).toBe(2);
  });

  it('exactly ONE MODERATE (editorial/self-submitted) source positively confirming Meme -> WEAK_MEME, never auto-upgraded to MEME (Part D rule 5)', () => {
    const result = classifyShadowMultiSource({
      tokenAddress: ADDR_A,
      chainId: 4663,
      stockClassification: 'NON_STOCK',
      sources: [{ ...COINGECKO, meme: true, project: null }],
    });
    expect(result.shadowAssetType).toBe('WEAK_MEME');
    expect(result.memeSourceCount).toBe(1);
  });

  it('a WEAK-quality single source is also WEAK_MEME, not MEME -- quality tier, not just count, gates the single-source promotion', () => {
    const result = classifyShadowMultiSource({
      tokenAddress: ADDR_A,
      chainId: 4663,
      stockClassification: 'NON_STOCK',
      sources: [{ sourceName: 'LowQualitySource', quality: 'WEAK', meme: true, project: null }],
    });
    expect(result.shadowAssetType).toBe('WEAK_MEME');
  });

  it('Uniswap V4 non-stock (real TWINE) remains NON_STOCK under the multi-source function too, regardless of source signals', () => {
    const result = classifyShadowMultiSource({
      tokenAddress: getAddress('0xe27501d787d647cc82a5b4a7eafd5750386f1b77'),
      chainId: 4663,
      stockClassification: 'NON_STOCK',
      sources: [{ ...COINGECKO, meme: false, project: null }, { ...CMC, meme: null, project: null }],
    });
    expect(result.shadowAssetType).not.toBe('STOCK');
  });

  it('shadow cannot affect the production gate: multi-source MEME result for a REAL confirmed Stock candidate still leaves the REAL screenCandidate rejection unchanged', async () => {
    // Phase 12: production now legitimately ALLOWS a confirmed NON_STOCK
    // candidate on its own merit, so the strongest proof that shadow has
    // zero influence is a case where production and shadow DISAGREE --
    // a real Stock candidate (production correctly rejects, hard safety,
    // unaffected by Phase 12) shadow-classified as MEME by two
    // corroborating editorial sources (shadow's own, independent belief).
    const candidate = makeCandidateToken({
      address: '0x' + '33'.repeat(20),
      symbol: 'MULTISRC',
      assetType: 'Stock',
      stockClassification: 'ROBINHOOD_OFFICIAL_STOCK',
    });
    const shadow = classifyShadowMultiSource({
      tokenAddress: getAddress(candidate.address),
      chainId: 4663,
      stockClassification: 'NON_STOCK', // shadow's own (hypothetically wrong) belief, independent of the real candidate above
      sources: [{ ...COINGECKO, meme: true, project: null }, { ...CMC, meme: true, project: null }],
    });
    expect(shadow.shadowAssetType).toBe('MEME');

    const results = await screenCandidates([candidate], {
      activePositionChecker: { hasActivePosition: async () => false },
      cooldownChecker: { getCooldownStatus: async () => ({ inCooldown: false, remainingMs: 0 }) },
    });
    expect(results[0]?.passed).toBe(false);
    expect(getPassingCandidates([candidate], results)).toHaveLength(0);
  });
});

describe('shadow mode cannot affect production (Parts F/G, K.10-11)', () => {
  it('10. structural proof: no production composition/filter/execution file imports the shadow classifier module', () => {
    const filesToCheck = [
      'src/filters/screenCandidate.ts',
      'src/composition/screeningCycle.ts',
      'src/composition/deps.ts',
      'src/composition/types.ts',
      'src/positions/openPosition.ts',
      'src/capital/decideCapitalAllocation.ts',
    ];
    for (const relPath of filesToCheck) {
      const content = readFileSync(join(__dirname, '../../', relPath), 'utf8');
      expect(content).not.toMatch(/shadowAssetClassifier/);
    }
  });

  it('10b. behavioral proof (updated for Phase 12 STOCK_ONLY mode): a candidate whose shadow classification is MEME still gets rejected by the REAL, unmodified ASSET_TYPE gate when the REAL Stock classifier confirms Stock', async () => {
    // Phase 12 changed production so a confirmed NON_STOCK candidate now
    // legitimately passes -- so this test now proves the invariant with a
    // scenario production is STILL correct to reject regardless of Phase 12:
    // a REAL confirmed Stock Token, where an (imagined, wrong) shadow Meme
    // signal must never override the real, safety-critical Stock rejection.
    const candidate = makeCandidateToken({
      address: '0x' + '22'.repeat(20),
      symbol: 'SHADOWTEST',
      assetType: 'Stock',
      stockClassification: 'ROBINHOOD_OFFICIAL_STOCK',
    });
    const shadowResult = classifyShadow({
      tokenAddress: getAddress(candidate.address),
      chainId: 4663,
      stockClassification: 'NON_STOCK', // shadow's OWN (hypothetically wrong) belief, independent of the real candidate's real classification above
      positiveSources: { meme: true, project: null },
    });
    expect(shadowResult.shadowAssetType).toBe('MEME'); // shadow says it WOULD pass

    // The REAL production screenCandidate/getPassingCandidates never see
    // the shadow result at all -- candidate.assetType/stockClassification untouched.
    const results = await screenCandidates([candidate], {
      activePositionChecker: { hasActivePosition: async () => false },
      cooldownChecker: { getCooldownStatus: async () => ({ inCooldown: false, remainingMs: 0 }) },
    });
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.failedRule).toBe('ASSET_TYPE');
    const passing = getPassingCandidates([candidate], results);
    expect(passing).toHaveLength(0); // never reaches openPosition
  });

  it('10c. Phase 12 sanity: a candidate confirmed NON_STOCK now legitimately passes production ASSET_TYPE on its own merit -- shadow agreeing with it is a non-event, not shadow causing it', async () => {
    const candidate = makeCandidateToken({ address: '0x' + '44'.repeat(20), symbol: 'REALPASS', assetType: 'Unknown', stockClassification: 'NON_STOCK' });
    const results = await screenCandidates([candidate], {
      activePositionChecker: { hasActivePosition: async () => false },
      cooldownChecker: { getCooldownStatus: async () => ({ inCooldown: false, remainingMs: 0 }) },
    });
    expect(results[0]?.passed).toBe(true);
    expect(getPassingCandidates([candidate], results)).toHaveLength(1);
  });

  it('11. buildShadowReport itself performs no I/O and returns a plain array -- nothing in its signature can reach openPosition', () => {
    const rows = buildShadowReport(
      [{ symbol: 'X', tokenAddress: ADDR_A, chainId: 4663, stockClassification: 'NON_STOCK', positiveSources: { meme: true, project: null }, currentProductionAssetType: 'Unknown' }],
      config.rules.filters.ALLOWED_ASSET_TYPES,
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]?.shadowWouldPass).toBe(true); // display-only column
    // Production's real ALLOWED_ASSET_TYPES is untouched by reading it here.
    expect(config.rules.filters.ALLOWED_ASSET_TYPES).toEqual(['Meme', 'Project']);
  });
});

describe('verifyAddressBinding -- Phase 11C Part G (address is the only real identity, symbol/name are auxiliary)', () => {
  const REAL = getAddress('0x78b96280c3347e0f58a7147b73eb0ec5ffff025d'); // real RSTR address

  it('6. address mismatch -> MISMATCH, never silently merged as positive evidence', () => {
    const claimed = getAddress('0x1111111111111111111111111111111111111111'); // some other token entirely
    expect(verifyAddressBinding(REAL, claimed)).toBe('MISMATCH');
  });

  it('7. symbol-only match (source makes no address claim at all) -> SYMBOL_ONLY, not production-eligible', () => {
    expect(verifyAddressBinding(REAL, null)).toBe('SYMBOL_ONLY');
  });

  it('a source whose claimed address matches exactly (case-insensitive) -> BOUND, the only result strong enough to feed a positive signal', () => {
    const claimedLowercase = REAL.toLowerCase() as `0x${string}`;
    expect(verifyAddressBinding(REAL, claimedLowercase)).toBe('BOUND');
  });

  it('real research finding: RSTR\'s own site (rstr.wtf) never mentions its contract address -> correctly SYMBOL_ONLY, so its "entertainment, not investment" language cannot be used as bound positive evidence', () => {
    // This documents an ACTUAL Phase 11C research result, not a hypothetical:
    // rstr.wtf was fetched and confirmed to contain no reference to
    // 0x78b96280c3347e0f58a7147b73eb0ec5ffff025d anywhere on the page.
    const noAddressClaimedBySite: `0x${string}` | null = null;
    expect(verifyAddressBinding(REAL, noAddressClaimedBySite)).toBe('SYMBOL_ONLY');
  });
});

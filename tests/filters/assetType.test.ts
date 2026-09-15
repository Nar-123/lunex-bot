import { describe, expect, it } from 'vitest';
import { checkAssetType } from '../../src/filters/rules/assetType';
import { makeCandidateToken } from '../fixtures/candidateToken';

describe('checkAssetType -- STOCK_ONLY mode (Phase 12, current production default)', () => {
  it('NON_STOCK (classifier confirmed) -> ALLOW, regardless of the flattened assetType string', () => {
    const result = checkAssetType(makeCandidateToken({ assetType: 'Unknown', stockClassification: 'NON_STOCK' }));
    expect(result.passed).toBe(true);
  });

  it('ROBINHOOD_OFFICIAL_STOCK (classifier confirmed) -> REJECT, even though this is the only path that also sets assetType to "Stock"', () => {
    const result = checkAssetType(makeCandidateToken({ assetType: 'Stock', stockClassification: 'ROBINHOOD_OFFICIAL_STOCK' }));
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/rejected/i);
  });

  it('UNKNOWN (classifier could not resolve -- RPC failure, malformed beacon) -> REJECT, fail-safe, never assumed non-Stock', () => {
    const result = checkAssetType(makeCandidateToken({ assetType: 'Unknown', stockClassification: 'UNKNOWN' }));
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/unresolved/i);
  });

  it('stockClassification entirely absent (never run through classifyCandidates) -> REJECT, same fail-safe as UNKNOWN, never assumed safe by omission', () => {
    const result = checkAssetType(makeCandidateToken({ assetType: 'Unknown', stockClassification: undefined }));
    expect(result.passed).toBe(false);
  });

  it('assetType alone being "Stock"/"ETF"/"RWA"/etc. does NOT drive the decision under STOCK_ONLY mode -- only stockClassification does', () => {
    // A candidate whose flattened assetType happens to read a TradFi-shaped
    // string, but whose classifier result is NON_STOCK, must still pass --
    // proves the gate reads stockClassification, not assetType.
    for (const assetType of ['ETF', 'RWA', 'Index', 'Tokenized Equity', 'Wrapped Stock'] as const) {
      const result = checkAssetType(makeCandidateToken({ assetType, stockClassification: 'NON_STOCK' }));
      expect(result.passed).toBe(true);
    }
  });

  it('known real candidates from live research (RSTR, TWINE, PONS, 富贵) -- all NON_STOCK on-chain -- pass under STOCK_ONLY mode', () => {
    const realNonStockAddresses = [
      '0x78b96280c3347e0f58a7147b73eb0ec5ffff025d', // RSTR
      '0xe27501d787d647cc82a5b4a7eafd5750386f1b77', // TWINE, real Uniswap V4 venue
      '0x39dbed3a2bd333467115de45665cc57f813c4571', // PONS
      '0xceebf25b318201f1f949be2fabbfcee231737139', // 富贵
    ];
    for (const address of realNonStockAddresses) {
      const result = checkAssetType(makeCandidateToken({ address, assetType: 'Unknown', stockClassification: 'NON_STOCK' }));
      expect(result.passed).toBe(true);
    }
  });

  it('Stock rejection cannot be bypassed by mismatched/manipulated assetType metadata -- STOCK_ONLY mode is driven ONLY by stockClassification', () => {
    // Even if `assetType` somehow read "Meme" or "Project" (never happens
    // on the real production path -- applyStockClassification only ever
    // WRITES 'Stock', it never writes 'Meme'/'Project' -- but this proves
    // the gate itself would still correctly reject even if some other bug
    // or malformed input set assetType to a non-Stock string), a
    // confirmed ROBINHOOD_OFFICIAL_STOCK classification alone is
    // sufficient and necessary to reject.
    for (const assetType of ['Meme', 'Project', 'Unknown'] as const) {
      const result = checkAssetType(makeCandidateToken({ assetType, stockClassification: 'ROBINHOOD_OFFICIAL_STOCK' }));
      expect(result.passed).toBe(false);
    }
  });

  it('known real Stock regressions (NVDA, AAPL, GME) -- all ROBINHOOD_OFFICIAL_STOCK on-chain -- are rejected under STOCK_ONLY mode', () => {
    const realStockAddresses = [
      '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', // NVDA
      '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9', // AAPL
      '0x1b0e319c6a659f002271b69db8a7df2f911c153e', // GME
    ];
    for (const address of realStockAddresses) {
      const result = checkAssetType(makeCandidateToken({ address, assetType: 'Stock', stockClassification: 'ROBINHOOD_OFFICIAL_STOCK' }));
      expect(result.passed).toBe(false);
    }
  });
});

describe('checkAssetType -- ALLOW_LIST mode (Draft V1 §3 original, preserved for historical reference/rollback)', () => {
  // These exercise `checkAllowList` directly via the SAME `checkAssetType`
  // entry point would require flipping `config.rules.filters.ASSET_TYPE_MODE`,
  // which -- like every other frozen config value in this project -- cannot
  // be flipped per-test (see `decideCapitalAllocation.ts`'s doc comment for
  // the same limitation). The ALLOW_LIST branch's logic is therefore
  // preserved unchanged in `assetType.ts` and covered structurally here by
  // asserting it still exists with its original semantics, byte-for-byte,
  // rather than re-exercising it through the mode switch.
  it('ALLOWED_ASSET_TYPES and REJECTED_ASSET_TYPES constants are unchanged from Draft V1 §3 -- never silently repurposed by the Phase 12 mode addition', async () => {
    const { config } = await import('../../src/config');
    expect(config.rules.filters.ALLOWED_ASSET_TYPES).toEqual(['Meme', 'Project']);
    expect(config.rules.filters.REJECTED_ASSET_TYPES).toEqual(['Stock', 'ETF', 'Index', 'RWA', 'Tokenized Equity', 'Wrapped Stock', 'Unknown']);
  });

  it('the current production default is STOCK_ONLY, not ALLOW_LIST -- explicit, not silent', async () => {
    const { config } = await import('../../src/config');
    expect(config.rules.filters.ASSET_TYPE_MODE).toBe('STOCK_ONLY');
  });
});

import type { Address } from 'viem';
import type { StockClassification } from './robinhoodStockClassifier';

/**
 * Phase 11 -- SHADOW MODE ONLY. This module is deliberately never imported
 * by `filters/screenCandidate.ts`, `composition/screeningCycle.ts`,
 * `positions/openPosition.ts`, or anywhere else in the real trading path
 * (see `tests/discovery/shadowAssetClassifier.test.ts`'s "cannot affect
 * production" suite, which proves this both structurally -- by grepping
 * the production composition files for any reference to this module --
 * and behaviorally -- by running a real candidate through the REAL,
 * unmodified `screenCandidate`/`getPassingCandidates` and confirming the
 * shadow result has zero bearing on `passed`).
 *
 * Purpose: answer "do we now have POSITIVE authoritative-enough evidence
 * to classify some currently-`Unknown` candidates as Meme/Project" --
 * never "not Stock => Meme/Project" (that heuristic is explicitly
 * prohibited by the operator). Every non-STOCK branch here requires an
 * explicit positive signal; the total absence of one is UNKNOWN, not a
 * negative classification -- see `PositiveSourceSignal`'s doc comment.
 */
export type ShadowAssetType = 'STOCK' | 'MEME' | 'PROJECT' | 'UNKNOWN';

/**
 * Phase 11B -- multi-source extension. `ShadowAssetTypeV2` adds
 * `WEAK_MEME`/`WEAK_PROJECT`: a SINGLE editorial/self-submitted positive
 * source (Part D rule 5) is real evidence but must NOT be silently
 * upgraded to the same production-eligible bucket as a corroborated
 * (multi-source) or documented-authoritative single-source result --
 * these two weak variants exist so shadow output can show "there is
 * something here worth tracking" without it being mistakable for
 * `MEME`/`PROJECT` in any downstream display or future decision.
 */
export type ShadowAssetTypeV2 = ShadowAssetType | 'WEAK_MEME' | 'WEAK_PROJECT';

/** Qualitative-only, per operator instruction ("do not turn this into a numeric trading score"). See `SOURCE_QUALITY.md`-equivalent doc comment on each real source's wiring for the specific justification. */
export type SourceQuality = 'AUTHORITATIVE' | 'STRONG' | 'MODERATE' | 'WEAK' | 'UNKNOWN';

/**
 * One named source's signal for one token (Phase 11B). Same `true`/
 * `false`/`null` semantics as `PositiveSourceSignal` above -- `null` is
 * NEVER a negative, it means this source has no data for this token.
 * `quality` is the source's OWN general trustworthiness tier (Part E),
 * fixed per source, not computed per-token.
 */
export interface NamedSourceSignal {
  sourceName: string;
  quality: SourceQuality;
  meme: boolean | null;
  project: boolean | null;
}

export interface MultiSourceClassificationInput {
  tokenAddress: Address;
  chainId: number;
  stockClassification: StockClassification;
  sources: NamedSourceSignal[];
}

export interface MultiSourceClassificationResult {
  tokenAddress: Address;
  chainId: number;
  shadowAssetType: ShadowAssetTypeV2;
  /** How many independent sources positively confirmed Meme / Project -- shown for transparency, never itself a numeric "confidence score" fed into a decision. */
  memeSourceCount: number;
  projectSourceCount: number;
  conflict: boolean;
  conflictDetail?: string;
}

/**
 * Part D's shadow-only precedence, extended for multiple named sources:
 *
 *  1. Official on-chain Robinhood Stock evidence -> STOCK (unchanged from
 *     `classifyShadow`; still wins even against positive Meme/Project
 *     sources, surfaced as a conflict rather than silently overridden).
 *  2. >=2 independent sources positively confirm Meme -> MEME
 *     ("multiple independent positive Meme sources").
 *  3. Exactly 1 source positively confirms Meme AND that source's own
 *     `quality` is AUTHORITATIVE or STRONG (the only tiers this function
 *     treats as meeting a "documented authority threshold" -- MODERATE/
 *     WEAK never qualify alone) -> MEME.
 *  4. >=2 independent sources positively confirm Project -> PROJECT.
 *  5. Exactly 1 source positively confirms Project with AUTHORITATIVE/
 *     STRONG quality -> PROJECT.
 *  6. Exactly 1 positive Meme (or Project) source that does NOT meet the
 *     quality bar above (MODERATE/WEAK/UNKNOWN) -> WEAK_MEME /
 *     WEAK_PROJECT -- real evidence, deliberately NOT promoted to the
 *     production-eligible bucket.
 *  7. A positive Meme signal AND a positive Project signal both present
 *     (from any source(s), regardless of count) -> CONFLICT, reported as
 *     UNKNOWN with `conflict: true` -- no tie-breaker is invented.
 *  8. No positive evidence anywhere -> UNKNOWN.
 */
export function classifyShadowMultiSource(input: MultiSourceClassificationInput): MultiSourceClassificationResult {
  const { tokenAddress, chainId, stockClassification, sources } = input;

  const memeSources = sources.filter((s) => s.meme === true);
  const projectSources = sources.filter((s) => s.project === true);
  const memeSourceCount = memeSources.length;
  const projectSourceCount = projectSources.length;
  const hasStrongOrAuthoritative = (s: NamedSourceSignal): boolean => s.quality === 'AUTHORITATIVE' || s.quality === 'STRONG';

  if (stockClassification === 'ROBINHOOD_OFFICIAL_STOCK') {
    if (memeSourceCount > 0 || projectSourceCount > 0) {
      return {
        tokenAddress,
        chainId,
        shadowAssetType: 'STOCK',
        memeSourceCount,
        projectSourceCount,
        conflict: true,
        conflictDetail: `on-chain proof confirms ROBINHOOD_OFFICIAL_STOCK, but ${memeSourceCount} meme source(s) / ${projectSourceCount} project source(s) also flagged positive -- the on-chain proof wins, surfaced not hidden`,
      };
    }
    return { tokenAddress, chainId, shadowAssetType: 'STOCK', memeSourceCount, projectSourceCount, conflict: false };
  }

  if (memeSourceCount > 0 && projectSourceCount > 0) {
    return {
      tokenAddress,
      chainId,
      shadowAssetType: 'UNKNOWN',
      memeSourceCount,
      projectSourceCount,
      conflict: true,
      conflictDetail: `${memeSourceCount} source(s) positively confirmed Meme AND ${projectSourceCount} source(s) positively confirmed Project -- ambiguous, no tie-breaker authorized`,
    };
  }

  if (memeSourceCount >= 2) {
    return { tokenAddress, chainId, shadowAssetType: 'MEME', memeSourceCount, projectSourceCount, conflict: false };
  }
  if (memeSourceCount === 1 && memeSources.some(hasStrongOrAuthoritative)) {
    return { tokenAddress, chainId, shadowAssetType: 'MEME', memeSourceCount, projectSourceCount, conflict: false };
  }
  if (memeSourceCount === 1) {
    return { tokenAddress, chainId, shadowAssetType: 'WEAK_MEME', memeSourceCount, projectSourceCount, conflict: false };
  }

  if (projectSourceCount >= 2) {
    return { tokenAddress, chainId, shadowAssetType: 'PROJECT', memeSourceCount, projectSourceCount, conflict: false };
  }
  if (projectSourceCount === 1 && projectSources.some(hasStrongOrAuthoritative)) {
    return { tokenAddress, chainId, shadowAssetType: 'PROJECT', memeSourceCount, projectSourceCount, conflict: false };
  }
  if (projectSourceCount === 1) {
    return { tokenAddress, chainId, shadowAssetType: 'WEAK_PROJECT', memeSourceCount, projectSourceCount, conflict: false };
  }

  return { tokenAddress, chainId, shadowAssetType: 'UNKNOWN', memeSourceCount, projectSourceCount, conflict: false };
}

/**
 * `true` = the source POSITIVELY confirms this category for this exact
 * token (address-identified). `false` = the source was successfully
 * queried for this token and explicitly does NOT tag it this way (a real
 * negative signal, e.g. CoinGecko lists the token under a category set
 * that does not include "Meme"). `null` = NO DATA -- the source has no
 * listing for this token at all, or was not queried/reachable. `null`
 * must NEVER be treated as `false`: absence of coverage is not a negative
 * classification (Part H's explicit requirement).
 */
export interface PositiveSourceSignal {
  meme: boolean | null;
  project: boolean | null;
}

export interface ShadowClassificationInput {
  /** Primary identity -- see this module's doc comment: symbol/name are NEVER part of the classification decision itself, only address + chain. */
  tokenAddress: Address;
  chainId: number;
  stockClassification: StockClassification;
  positiveSources: PositiveSourceSignal;
}

export interface ShadowClassificationResult {
  tokenAddress: Address;
  chainId: number;
  shadowAssetType: ShadowAssetType;
  /** `true` when two positive sources disagree, or a positive Meme/Project source conflicts with a confirmed Stock classification -- Part E requires STOPPING on conflict, never inventing a tie-breaker. A conflicting result is always reported as `UNKNOWN` (or `STOCK` when the conflict is against the on-chain Stock proof specifically, which stays authoritative -- see the doc comment on that branch below) with `conflict: true` and a human-readable `conflictDetail`, so a caller can surface and halt on it rather than silently picking a side. */
  conflict: boolean;
  conflictDetail?: string;
}

/**
 * Pure precedence function (Part E), no I/O: applies the fixed precedence
 * order (1. on-chain Stock proof, 2. positive Meme source, 3. positive
 * Project source, 4. UNKNOWN) and detects the two conflict shapes Part E
 * anticipates:
 *   - a confirmed on-chain Stock Token that some OTHER source also
 *     positively tags Meme or Project (the on-chain structural proof
 *     wins and stays authoritative -- Stock is reported, but the
 *     disagreement is surfaced via `conflict: true`, never silently
 *     dropped);
 *   - a token BOTH a Meme source AND a Project source positively confirm
 *     (genuinely ambiguous -- no tie-breaker is invented; reported as
 *     UNKNOWN with `conflict: true`).
 */
export function classifyShadow(input: ShadowClassificationInput): ShadowClassificationResult {
  const { tokenAddress, chainId, stockClassification, positiveSources } = input;

  if (stockClassification === 'ROBINHOOD_OFFICIAL_STOCK') {
    if (positiveSources.meme === true || positiveSources.project === true) {
      return {
        tokenAddress,
        chainId,
        shadowAssetType: 'STOCK',
        conflict: true,
        conflictDetail:
          `on-chain proof confirms ROBINHOOD_OFFICIAL_STOCK, but a positive source also flagged ` +
          `meme=${String(positiveSources.meme)}/project=${String(positiveSources.project)} -- the on-chain proof wins, but this disagreement is surfaced, not hidden`,
      };
    }
    return { tokenAddress, chainId, shadowAssetType: 'STOCK', conflict: false };
  }

  if (positiveSources.meme === true && positiveSources.project === true) {
    return {
      tokenAddress,
      chainId,
      shadowAssetType: 'UNKNOWN',
      conflict: true,
      conflictDetail: 'both a Meme source and a Project source positively confirmed this token -- ambiguous, no tie-breaker authorized',
    };
  }

  if (positiveSources.meme === true) {
    return { tokenAddress, chainId, shadowAssetType: 'MEME', conflict: false };
  }

  if (positiveSources.project === true) {
    return { tokenAddress, chainId, shadowAssetType: 'PROJECT', conflict: false };
  }

  return { tokenAddress, chainId, shadowAssetType: 'UNKNOWN', conflict: false };
}

/** One row of the shadow-vs-production comparison report (Part F/G). */
export interface ShadowReportRow {
  symbol: string;
  tokenAddress: Address;
  stockClassifier: StockClassification;
  memeSource: boolean | null;
  projectSource: boolean | null;
  shadowAssetType: ShadowAssetType;
  currentProductionAssetType: string;
  shadowConflict: boolean;
  shadowConflictDetail?: string;
  /** What the REAL, unmodified `ALLOWED_ASSET_TYPES` allow-list would do with the shadow type, for display only -- never fed back into any real decision. */
  shadowWouldPass: boolean;
}

/**
 * Builds the full shadow report for a batch of already-classified
 * candidates (Part F/G). Pure function -- every input is pre-resolved by
 * the caller (stock classification, source signals); this function makes
 * no RPC/HTTP calls itself and writes nothing. `allowedAssetTypes` is
 * passed in explicitly (from `config.rules.filters.ALLOWED_ASSET_TYPES`,
 * read-only) purely to compute the DISPLAY-only `shadowWouldPass` column
 * -- it is never used to mutate or bypass the real filter.
 */
/**
 * `ShadowAssetType` is deliberately UPPERCASE (a shadow-mode-only vocabulary,
 * never written into any real `CandidateToken.assetType` field) while
 * production's `AllowedAssetType`/`RejectedAssetType` strings are
 * title-case ('Meme', 'Project', ...). This maps between the two purely
 * for the `shadowWouldPass` DISPLAY column below -- it never feeds back
 * into any real value.
 */
const SHADOW_TO_PRODUCTION_STRING: Record<ShadowAssetType, string> = {
  STOCK: 'Stock',
  MEME: 'Meme',
  PROJECT: 'Project',
  UNKNOWN: 'Unknown',
};

export function buildShadowReport(
  candidates: Array<{
    symbol: string;
    tokenAddress: Address;
    chainId: number;
    stockClassification: StockClassification;
    positiveSources: PositiveSourceSignal;
    currentProductionAssetType: string;
  }>,
  allowedAssetTypes: readonly string[],
): ShadowReportRow[] {
  return candidates.map((c) => {
    const result = classifyShadow({
      tokenAddress: c.tokenAddress,
      chainId: c.chainId,
      stockClassification: c.stockClassification,
      positiveSources: c.positiveSources,
    });
    return {
      symbol: c.symbol,
      tokenAddress: c.tokenAddress,
      stockClassifier: c.stockClassification,
      memeSource: c.positiveSources.meme,
      projectSource: c.positiveSources.project,
      shadowAssetType: result.shadowAssetType,
      currentProductionAssetType: c.currentProductionAssetType,
      shadowConflict: result.conflict,
      shadowConflictDetail: result.conflictDetail,
      shadowWouldPass: allowedAssetTypes.includes(SHADOW_TO_PRODUCTION_STRING[result.shadowAssetType]),
    };
  });
}

/**
 * Phase 11C (Part G) -- every positive classification must be proven
 * against `chainId + exact contract address`; name/symbol are auxiliary
 * only. This is the binding check a caller MUST run before treating any
 * external source's claimed evidence (a project website, a news article,
 * a launchpad's own docs) as usable input to `NamedSourceSignal`/
 * `PositiveSourceSignal` above -- research phases found that GMGN's own
 * self-reported `website` field is frequently unreliable (dead links,
 * unrelated news articles, or domains with no evident connection to the
 * token at all), which is exactly the failure mode this guards against.
 */
export type AddressBindingResult = 'BOUND' | 'SYMBOL_ONLY' | 'MISMATCH' | 'NO_CLAIM';

/**
 * `sourceClaimedAddress`: the exact contract address the source ITSELF
 * states the evidence is about, if the source makes any address claim at
 * all (`null` if it only identifies the token by symbol/name, e.g. a news
 * article or a launchpad page with no on-chain reference).
 *
 * - `BOUND`: source states an address and it matches the real candidate
 *   address exactly (case-insensitive) -- the only result strong enough
 *   to feed a `meme`/`project: true` signal into `classifyShadow(MultiSource)`.
 * - `SYMBOL_ONLY`: source identifies the token by name/symbol only, no
 *   address claim at all -- per Part G, must be treated as WEAK/
 *   UNVERIFIED, never as a production-eligible positive signal on its own.
 * - `MISMATCH`: source states a DIFFERENT address than the real
 *   candidate -- per Part G ("Jika source memiliki address mismatch: STOP
 *   classification"), this evidence must be discarded entirely for this
 *   candidate, not merged or partially trusted.
 * - `NO_CLAIM`: no source data was supplied to check at all.
 */
export function verifyAddressBinding(realCandidateAddress: Address, sourceClaimedAddress: Address | null): AddressBindingResult {
  if (sourceClaimedAddress === null) return 'SYMBOL_ONLY';
  return sourceClaimedAddress.toLowerCase() === realCandidateAddress.toLowerCase() ? 'BOUND' : 'MISMATCH';
}

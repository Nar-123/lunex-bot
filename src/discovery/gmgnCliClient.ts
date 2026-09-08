import { config } from '../config';
import { getGmgnChainSlug } from '../config/constants';
import type { GetTopTokensParams, GmgnClient } from './gmgnClient';
import type { CandidateToken } from './types';
import { mapTrendingResponseToPartialCandidates, parseTokenInfo, mergeCreatedAt } from './gmgnMapper';
import {
  runGmgnCliJson,
  assertValidEvmAddress,
  assertValidChainSlug,
  assertValidTimeframe,
  assertValidLimit,
  type RunGmgnCliOptions,
} from './cliExec';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
/**
 * Sequential, not parallel, and deliberately spaced out: a discovery
 * cycle now issues 1 `market trending` call plus up to
 * `config.rules.discovery.TOP_N` (10) extra `token info` calls (age isn't
 * in the trending response at all). GMGN's real request budget/rate limit
 * is unknown/undocumented, so this stays conservative rather than firing
 * 10 concurrent child processes at it.
 */
const TOKEN_INFO_INTER_CALL_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RunCliFn = (
  cliPath: string,
  args: readonly string[],
  options: RunGmgnCliOptions,
) => Promise<unknown>;

/**
 * GMGN integration, implemented as a `gmgn-cli` child process rather than
 * a direct HTTP call (per verified production usage). Every argument that
 * reaches `execFile`'s argv is either a value we chose ourselves (chain
 * slug, timeframe, limit) or a GMGN-returned EVM address that has already
 * passed `assertValidEvmAddress` -- token name/symbol (free-form,
 * attacker-controlled) are NEVER passed as CLI arguments, only sanitized
 * for display (see `gmgnMapper.ts` / `sanitize.ts`).
 *
 * `runCli` is injectable so tests can exercise the two-call
 * (trending + per-candidate token-info) orchestration, retry, and
 * partial-failure logic without spawning a real process.
 */
export class GmgnCliClient implements GmgnClient {
  constructor(
    private readonly cliPath: string = config.gmgn.cliPath,
    private readonly apiKey: string = config.gmgn.apiKey,
    private readonly execOptions: Omit<RunGmgnCliOptions, 'env'> = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
      retryBaseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
    },
    private readonly runCli: RunCliFn = runGmgnCliJson,
    private readonly onTokenInfoFailure: (symbol: string, address: string, err: unknown) => void = defaultWarn,
  ) {}

  private childEnv(): NodeJS.ProcessEnv {
    // Secrets travel via env, never argv -- argv is visible to other local
    // processes (e.g. `ps`), env vars passed this way are not.
    return this.apiKey ? { ...process.env, GMGN_API_KEY: this.apiKey } : process.env;
  }

  async getTopTokens({ timeframe, limit }: GetTopTokensParams): Promise<CandidateToken[]> {
    const chainSlug = assertValidChainSlug(getGmgnChainSlug(config.chain.chainId));
    const safeTimeframe = assertValidTimeframe(timeframe);
    const safeLimit = assertValidLimit(limit);

    const trendingBody = await this.runCli(
      this.cliPath,
      ['market', 'trending', '--chain', chainSlug, '--timeframe', safeTimeframe, '--limit', String(safeLimit), '--json'],
      { ...this.execOptions, env: this.childEnv() },
    );

    const partials = mapTrendingResponseToPartialCandidates(trendingBody, {
      chainId: config.chain.chainId,
      discoveredAt: Date.now(),
    });

    const enriched: CandidateToken[] = [];
    for (const partial of partials) {
      try {
        const address = assertValidEvmAddress(partial.address);
        const infoBody = await this.runCli(
          this.cliPath,
          ['token', 'info', '--chain', chainSlug, '--address', address, '--json'],
          { ...this.execOptions, env: this.childEnv() },
        );
        const tokenInfo = parseTokenInfo(infoBody);
        enriched.push(mergeCreatedAt(partial, tokenInfo));
      } catch (err) {
        // A single candidate's `token info` failing does not invalidate
        // the whole cycle -- skip just this one (its age can't be
        // verified, so it could never pass TOKEN_AGE anyway). This is NOT
        // the "collapse to empty array" failure mode `market trending`
        // itself must avoid -- that call always throws on a bad response,
        // never silently returns [].
        this.onTokenInfoFailure(partial.symbol, partial.address, err);
      }
      await sleep(TOKEN_INFO_INTER_CALL_DELAY_MS);
    }

    return enriched;
  }
}

function defaultWarn(symbol: string, address: string, err: unknown): void {
  // Temporary: replaced by the shared logger once a logging module exists.
  console.warn(
    `[gmgn] token info lookup failed for ${symbol} (${address}), excluding from this cycle:`,
    err instanceof Error ? err.message : err,
  );
}

import type { CandidateToken } from './types';

export interface GetTopTokensParams {
  /** e.g. "6h" — the gmgn-cli `--interval` value (1m/5m/1h/6h/24h). */
  interval: string;
  limit: number;
}

/**
 * Port for the discovery data source. `discoveryService.ts` and every
 * downstream module depend only on this interface, never on a concrete
 * HTTP client — that keeps the (currently unconfirmed, see
 * `gmgnHttpClient.ts`) GMGN integration swappable and trivially mockable
 * in tests.
 */
export interface GmgnClient {
  getTopTokens(params: GetTopTokensParams): Promise<CandidateToken[]>;
}

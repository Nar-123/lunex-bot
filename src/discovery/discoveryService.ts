import { config } from '../config';
import type { GmgnClient } from './gmgnClient';
import type { CandidateToken } from './types';

/**
 * Runs one discovery cycle: fetch the GMGN 6H Top-10 and hand back
 * normalized candidates, ranked. Screening/filtering happens downstream in
 * `filters/` — this module only discovers and normalizes.
 */
export class DiscoveryService {
  constructor(private readonly client: GmgnClient) {}

  async discoverTopCandidates(): Promise<CandidateToken[]> {
    const tokens = await this.client.getTopTokens({
      timeframe: config.rules.discovery.TIMEFRAME.toLowerCase(),
      limit: config.rules.discovery.TOP_N,
    });
    return tokens.slice(0, config.rules.discovery.TOP_N).sort((a, b) => a.rank - b.rank);
  }
}

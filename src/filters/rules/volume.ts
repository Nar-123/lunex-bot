import { config } from '../../config';
import type { CandidateToken } from '../../discovery/types';
import type { FilterCheckResult } from '../types';

/** Spec requires volume strictly > 0 — not >= 0. */
export function checkVolume(token: CandidateToken): FilterCheckResult {
  const min = config.rules.filters.MIN_VOLUME_USD;
  const passed = token.volumeUsd > min;
  return {
    rule: 'VOLUME',
    passed,
    reason: passed
      ? `volume $${token.volumeUsd.toLocaleString()} > ${min}`
      : `volume $${token.volumeUsd.toLocaleString()} is not > ${min}`,
    meta: { volumeUsd: token.volumeUsd, minRequired: min },
  };
}

import { vi } from 'vitest';
import type { Permit2PreflightResult } from '../../src/positions/permit2Preflight';

/** A deployable, no-approval-needed Permit2 pre-flight -- the default for tests not exercising Permit2 itself (never touches an RPC). */
export function validPermit2(overrides: Partial<Permit2PreflightResult> = {}): Permit2PreflightResult {
  return { status: 'VALID', deployable: true, needsErc20Approval: false, reason: 'test: Permit2 path valid', grantExpiration: 2_000_000_000, secondsUntilExpiry: 1_000_000, expiringSoon: false, grantNonce: 1, ...overrides };
}

export function validPermit2Preflight() {
  return vi.fn(async () => validPermit2());
}

import type { TokenGrantAssessment } from '../../src/exits/permit2TokenGrant';

/**
 * Test stub for the exit-side Permit2 token-grant pre-flight.
 *
 * The real pre-flight reads the chain. Tests that are exercising OTHER parts of
 * the exit state machine inject this so the grant leg is a no-op for them; the
 * grant leg's own behaviour is covered by `tests/exits/permit2TokenGrant.test.ts`
 * and the real-SQLite integration test, which never use this stub.
 */
export const grantAlreadyValid = (): Promise<TokenGrantAssessment> =>
  Promise.resolve({
    status: 'VALID',
    reason: 'test stub: grant already sufficient',
    needsApproval: false,
    current: { amount: 2n ** 160n - 1n, expiration: 4_000_000_000, nonce: 0 },
    secondsUntilExpiry: 4_000_000_000,
    approval: null,
  });

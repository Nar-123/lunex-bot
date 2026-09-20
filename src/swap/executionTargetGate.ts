/**
 * Process-wide result of the READ-ONLY execution-target identity assertion
 * (`verifyExecutionTargets.ts`), consulted by `validateSwapQuote`.
 *
 *  NOT_CHECKED  the assertion has not run (unit tests, and the window before
 *               startup wiring completes). Validation proceeds on the
 *               configured allowlists alone -- the allowlists are themselves
 *               fail-closed, so this is not a bypass.
 *  VERIFIED     every configured router/proxy exists on the expected chain and
 *               matches its expected identity.
 *  FAILED       an identity assertion failed. Exits must not sign or send:
 *               `validateSwapQuote` rejects every swap while this is set, which
 *               surfaces through the ordinary deterministic-block path
 *               (operator-visible, backed off) instead of crashing the bot or
 *               silently trusting a mismatched contract.
 *
 * Monitoring, price polling and exit DECISIONS are unaffected -- only the act
 * of building/signing an exit swap is gated.
 */
export type ExecutionTargetVerificationState = 'NOT_CHECKED' | 'VERIFIED' | 'FAILED';

let state: ExecutionTargetVerificationState = 'NOT_CHECKED';
let detail: string | null = null;

export function setExecutionTargetVerification(next: ExecutionTargetVerificationState, reason: string | null = null): void {
  state = next;
  detail = reason;
}

export function getExecutionTargetVerification(): ExecutionTargetVerificationState {
  return state;
}

export function getExecutionTargetVerificationDetail(): string | null {
  return detail;
}

/** Test-only helper: restores the pristine state so one test can never leak a gate into another. */
export function resetExecutionTargetVerification(): void {
  state = 'NOT_CHECKED';
  detail = null;
}

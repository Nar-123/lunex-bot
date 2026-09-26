/**
 * Policy for the ONE ERC20 allowance an exit swap may ever grant.
 *
 * ## Why this is Permit2-only
 *
 * The Permit2-enabled Trading API flow (exit-router resolution, 2026-09-20)
 * has the approved Universal Router pull the position's TOKEN through Permit2:
 *
 *   wallet -> UniversalRouter.execute(V2/V3 exact-in, payerIsUser=true)
 *          -> Permit2.transferFrom(wallet, pool, amount, TOKEN)
 *          -> TOKEN.transferFrom(wallet, pool, amount)   [spender = Permit2]
 *
 * so the only ERC20 allowance that path consumes is `TOKEN -> Permit2`. The
 * router itself never calls `transferFrom` as the spender, and no SwapProxy is
 * involved in the D6+ flow at all.
 *
 * Until now this leg reused the SWAP-TARGET allowlist (`classifyApprovalSpender`,
 * i.e. "an approved Universal Router or SwapProxy"), which was wrong in both
 * directions:
 *
 *  - it ACCEPTED a router/proxy as an allowance spender, an authority the exit
 *    flow has no use for;
 *  - it REFUSED Permit2, the one spender the flow actually needs -- so on a
 *    clean wallet the exit blocked with APPROVAL_SPENDER_NOT_APPROVED. That
 *    never surfaced in production only because the executor wallet already
 *    carried unlimited TOKEN -> Permit2 allowances created months earlier by a
 *    consumer wallet app (see the 2026-09-26 wallet audit). A dedicated,
 *    freshly generated executor has no such allowance, and could not exit.
 *
 * The spender is therefore compared against the PROJECT'S OWN CONFIGURED
 * Permit2 address, never against anything the provider returned: the API's
 * answer selects *whether* an approval is needed, and this policy decides
 * *who* may receive it. An address that merely resembles Permit2, a legacy or
 * approved SwapProxy, a Universal Router, or any other contract is refused.
 *
 * The amount is checked here too: an exit only ever approves the exact,
 * receipt-proven amount it is about to sell (D8 FIX 1), so a non-positive
 * amount is a bug, not an approval to send.
 *
 * Pure and exported for direct unit testing -- the swap-target allowlist
 * (`swap/executionTargets.ts`, used by `validateSwapQuote`) is untouched and
 * still governs what may be CALLED.
 */

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type ExitApprovalSpenderRefusal =
  /** The configured Permit2 address is missing/malformed -- fail closed, approve nothing. */
  | 'PERMIT2_NOT_CONFIGURED'
  /** The provider named something that is not the configured Permit2. */
  | 'SPENDER_NOT_PERMIT2'
  /** The amount to approve is not positive. */
  | 'NON_POSITIVE_AMOUNT';

export type ExitApprovalSpenderDecision =
  | { ok: true; spender: string }
  | { ok: false; refusal: ExitApprovalSpenderRefusal; reason: string };

export interface ExitApprovalSpenderInput {
  /** Exactly what the provider asked us to approve -- untrusted. */
  spender: string;
  /** From project configuration (`config.uniswap.v4.permit2`) -- the only trusted source. */
  configuredPermit2: string;
  /** The receipt-proven amount this exit is about to sell (D8 FIX 1). */
  amountRaw: bigint;
}

/**
 * Accepts an ERC20 approval spender ONLY when it is the configured Permit2
 * address and the amount is positive. Never throws: a malformed input is a
 * refusal, so a bad provider response can never become an approval.
 */
export function classifyExitApprovalSpender(input: ExitApprovalSpenderInput): ExitApprovalSpenderDecision {
  const { spender, configuredPermit2, amountRaw } = input;

  if (typeof configuredPermit2 !== 'string' || !EVM_ADDRESS_RE.test(configuredPermit2) || configuredPermit2.toLowerCase() === ZERO_ADDRESS) {
    return {
      ok: false,
      refusal: 'PERMIT2_NOT_CONFIGURED',
      reason: `no usable Permit2 address is configured (got ${configuredPermit2}) -- refusing to grant any exit allowance`,
    };
  }
  if (typeof spender !== 'string' || !EVM_ADDRESS_RE.test(spender)) {
    return {
      ok: false,
      refusal: 'SPENDER_NOT_PERMIT2',
      reason: `provider asked to approve ${spender}, which is not a well-formed address -- only the configured Permit2 ${configuredPermit2} may be approved`,
    };
  }
  if (spender.toLowerCase() !== configuredPermit2.toLowerCase()) {
    return {
      ok: false,
      refusal: 'SPENDER_NOT_PERMIT2',
      reason:
        `provider asked to approve spender ${spender}, but an exit swap only ever needs an allowance for the configured ` +
        `Permit2 ${configuredPermit2} (the Universal Router pulls the TOKEN through Permit2) -- no approval sent`,
    };
  }
  if (typeof amountRaw !== 'bigint' || amountRaw <= 0n) {
    return {
      ok: false,
      refusal: 'NON_POSITIVE_AMOUNT',
      reason: `refusing to approve a non-positive amount (${String(amountRaw)}) -- an exit approves exactly the TOKEN its own receipt proved`,
    };
  }
  // Deliberately returns the CONFIGURED address, not the provider's echo of it:
  // the approval is then built from project configuration end to end, and the
  // provider's string (whatever its casing) never reaches the calldata. Callers
  // use this value rather than the raw field (`executeExit.ts`'s `approvedSpender`).
  return { ok: true, spender: configuredPermit2 };
}

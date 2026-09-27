import type { Address } from 'viem';
import type { TxRequest } from '../execution/types';
import { classifyExecutionTarget, type ExecutionTargetMatch, type ExecutionTargetPolicy } from './executionTargets';
import type { ExecutionTargetVerificationState } from './executionTargetGate';
import { assertUniversalRouterCallSafe, UniversalRouterCalldataError } from './universalRouterCalldata';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_DATA_RE = /^0x[0-9a-fA-F]*$/;
/** 0x + 4-byte function selector (8 hex chars) = 10 chars minimum -- shorter than this can never be a real contract call. */
const MIN_DATA_LENGTH = 10;

export class SwapQuoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwapQuoteValidationError';
  }
}

/** The raw, not-yet-trusted shape a `SwapExecutor` implementation maps an external API's response into, before it's handed here. */
export interface RawSwapTxCandidate {
  to: string;
  data: string;
  value: string;
  chainId: number;
  /** What the API says it built this calldata's `amount_in` for -- MUST match what we actually requested. */
  echoedAmountInRaw: bigint;
  minOutputAmountRaw: bigint;
}

/**
 * Structural validation for ANY externally-sourced swap calldata, run
 * BEFORE it is ever handed to `executeCriticalTransaction` for
 * sign+broadcast -- adapted from the pattern given in review (originally
 * shown against GMGN's raw JSON field names; generalized here to operate
 * on an already-mapped, provider-agnostic shape so it works the same way
 * regardless of which `SwapExecutor` implementation produced it). Treats
 * the payload as untrusted external data, exactly like every other
 * external data source in this project (GMGN discovery responses, etc.) --
 * never assumed safe just because it came from an API.
 *
 * Throws (never silently coerces/clamps/drops a field) on any violation --
 * a swap must fail loudly rather than sign something that doesn't match
 * what was actually requested.
 *
 * ## Two-layer target validation (exit-router incident, 2026-09-20)
 *
 * The Trading API's proxy approval flow no longer targets a Universal Router
 * directly: it targets a SwapProxy that takes the router to call as its FIRST
 * CALLDATA ARGUMENT. Allowlisting the proxy alone would authorise arbitrary
 * routers, so BOTH layers are checked here (see `executionTargets.ts`):
 *
 *   CASE A  to == approved Universal Router  -> direct-router rules
 *   CASE B  to == approved SwapProxy         -> decode calldata, embedded
 *                                               router must ALSO be approved,
 *                                               and its token/amount must match
 *                                               the quote this swap was built for
 *   CASE C  to == anything else              -> reject (covers the deprecated
 *                                               proxy and any unverified router)
 *
 * Proxy validation is never treated as equivalent to router validation.
 *
 * ## H9 fix — target identity, not just address shape
 *
 * The previous version of this function only checked that `to` "looks
 * like an address" (a regex), despite its own doc comment already
 * claiming the payload is "treated as untrusted" -- a regex proves
 * nothing about WHICH contract the calldata targets, which is exactly the
 * highest-risk field in the whole payload (arbitrary calldata to an
 * arbitrary address, signed and broadcast by the executor wallet). This
 * now requires an EXACT match against `expected.allowedRouterAddress`
 * (chain-specific, sourced from config -- see `config/types.ts`'s
 * `UniswapTradingApiConfig.allowedRouterAddress` -- never a hardcoded
 * address with no cited source). Per explicit review: if that address
 * isn't configured/confirmed, this FAILS CLOSED (rejects every swap)
 * rather than silently falling back to shape-only validation.
 *
 * `value` must be exactly `0` -- every swap this project ever builds is
 * ERC20 (TOKEN) -> ERC20 (USDG); native ETH is never involved, so any
 * non-zero value is itself a red flag, not a normal variation to accept.
 */
export interface SwapQuoteExpectation {
  amountInRaw: bigint;
  chainId: number;
  minReceivedRequired: boolean;
  /** Chain-scoped approved execution targets. Empty router list = fail closed. */
  targets: ExecutionTargetPolicy;
  /** The TOKEN being sold -- cross-checked against SwapProxy calldata so a proxy payload cannot swap a different asset. */
  tokenIn: string;
  /**
   * D8: the OFFICIAL configured quote asset (USDG) every swap leg must pay
   * out. Required for CASE A (direct Universal Router); its absence there is
   * fail-closed, exactly like a missing `recipient`, because a batch whose
   * destination asset was never checked is not a validated batch.
   */
  tokenOut?: string;
  /** Startup identity-assertion state; `FAILED` blocks every swap (see `executionTargetGate.ts`). */
  identityGate?: ExecutionTargetVerificationState;
  /**
   * EXIT-ROUTER RESOLUTION: the wallet that must receive the swap output, and
   * the clock used only to reject an already-expired router deadline. Required
   * for CASE A (direct Universal Router), which is now the production path.
   */
  recipient?: string;
  now?: number;
}

export function validateSwapQuote(candidate: RawSwapTxCandidate, expected: SwapQuoteExpectation): TxRequest {
  if (candidate.chainId !== expected.chainId) {
    throw new SwapQuoteValidationError(`swap tx chainId mismatch: got ${candidate.chainId}, expected ${expected.chainId}`);
  }
  if (!EVM_ADDRESS_RE.test(candidate.to)) {
    throw new SwapQuoteValidationError(`swap tx "to" is not a well-formed EVM address: ${candidate.to}`);
  }
  // Startup identity assertion: a FAILED verification blocks every swap.
  if (expected.identityGate === 'FAILED') {
    throw new SwapQuoteValidationError(
      'execution-target identity verification FAILED at startup -- refusing to sign any exit swap until the configured router/proxy identities check out (fail closed)',
    );
  }

  // Layer 1 -- the transaction target itself.
  let match: ExecutionTargetMatch | null;
  try {
    match = classifyExecutionTarget(candidate.to, expected.targets);
  } catch (err) {
    // Unusable policy (no approved router configured) or a malformed allowlist entry: fail closed.
    throw new SwapQuoteValidationError(err instanceof Error ? err.message : String(err));
  }
  if (match === null) {
    throw new SwapQuoteValidationError(
      `swap tx "to" (${candidate.to}) is not an approved execution target for chain ${expected.targets.chainId} ` +
        `-- approved routers: [${expected.targets.universalRouters.join(', ') || 'none'}], approved proxies: [${expected.targets.swapProxies.join(', ') || 'none'}]. ` +
        'Refusing to sign calldata for an unrecognized target.',
    );
  }

  // Layer 2a -- CASE A: a direct call to an approved Universal Router. The
  // calldata is a command batch, so the batch itself is the thing that has to
  // be safe: no command requiring a signature this project cannot produce, no
  // command it has never reasoned about, and swap parameters that match the
  // quote this call was built for.
  if (match.kind === 'UNIVERSAL_ROUTER') {
    if (expected.recipient === undefined || expected.now === undefined || expected.tokenOut === undefined) {
      throw new SwapQuoteValidationError(
        'direct Universal Router calldata cannot be validated without the expected recipient, output token and current time -- refusing to sign an unchecked command batch (fail closed)',
      );
    }
    try {
      assertUniversalRouterCallSafe(candidate.data, {
        tokenIn: expected.tokenIn,
        tokenOut: expected.tokenOut,
        amountInRaw: expected.amountInRaw,
        minOutputAmountRaw: candidate.minOutputAmountRaw,
        minReceivedRequired: expected.minReceivedRequired,
        recipient: expected.recipient,
        now: expected.now,
      });
    } catch (err) {
      if (err instanceof UniversalRouterCalldataError) throw new SwapQuoteValidationError(err.message);
      throw err;
    }
  }

  // Layer 2b -- SWAP_PROXY is REFUSED OUTRIGHT, before anything can be signed.
  //
  // The proxy path was validated by decoding `execute()` and checking the
  // router/token/amount it named. That decode only covers the three head words
  // it understands; it cannot establish what the proxy actually DOES with the
  // approval it pulls, and the proxy is not a contract this project verified
  // the bytecode of beyond a code-hash presence check. A swap is only as safe
  // as the last hop that moves the funds, so the router batch itself has to be
  // the thing under validation -- which is exactly what CASE A does with
  // `assertUniversalRouterCallSafe`.
  //
  // Deliberately NOT a new/stricter proxy decoder: the direct Universal Router
  // path is the production path (D7 onwards) and covers every exit this bot
  // builds, so the proxy branch is dead weight carrying live risk. It is
  // rejected here -- inside the same pre-sign validation every swap must pass
  // -- rather than by editing the allowlist, so the refusal holds no matter how
  // `EXECUTION_TARGETS` is configured and cannot be re-enabled by config drift.
  if (match.kind === 'SWAP_PROXY') {
    throw new SwapQuoteValidationError(
      `swap tx targets SwapProxy ${match.address}, and the SwapProxy execution path is disabled -- ` +
        'only a direct call to an approved Universal Router may be signed (fail closed). ' +
        'Refusing to sign proxy calldata.',
    );
  }
  if (!HEX_DATA_RE.test(candidate.data) || candidate.data.length < MIN_DATA_LENGTH) {
    throw new SwapQuoteValidationError(`swap tx "data" is not well-formed calldata (got length ${candidate.data.length})`);
  }
  if (candidate.echoedAmountInRaw !== expected.amountInRaw) {
    throw new SwapQuoteValidationError(
      `swap tx amount-in mismatch: API built calldata for ${candidate.echoedAmountInRaw}, but ${expected.amountInRaw} was requested`,
    );
  }
  if (expected.minReceivedRequired && candidate.minOutputAmountRaw <= 0n) {
    throw new SwapQuoteValidationError('minimum-received protection is enabled but the quote has a zero/missing minOutputAmountRaw');
  }

  let value: bigint;
  try {
    value = BigInt(candidate.value);
  } catch {
    throw new SwapQuoteValidationError(`swap tx "value" is not a valid integer string: ${candidate.value}`);
  }
  if (value !== 0n) {
    // Every swap here is ERC20 TOKEN -> ERC20 USDG -- native ETH is never
    // involved, so a non-zero value is a red flag, not a normal variation.
    throw new SwapQuoteValidationError(`swap tx "value" must be 0 for an ERC20->ERC20 swap, got ${value}`);
  }

  return { to: candidate.to as Address, data: candidate.data as `0x${string}`, value };
}

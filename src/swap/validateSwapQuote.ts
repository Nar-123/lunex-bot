import type { Address } from 'viem';
import type { TxRequest } from '../execution/types';
import { classifyExecutionTarget, decodeSwapProxyExecute, isApprovedUniversalRouter, type ExecutionTargetMatch, type ExecutionTargetPolicy } from './executionTargets';
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
    if (expected.recipient === undefined || expected.now === undefined) {
      throw new SwapQuoteValidationError(
        'direct Universal Router calldata cannot be validated without the expected recipient and current time -- refusing to sign an unchecked command batch (fail closed)',
      );
    }
    try {
      assertUniversalRouterCallSafe(candidate.data, {
        tokenIn: expected.tokenIn,
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

  // Layer 2b -- when the target is a SwapProxy, the router it will call must be approved too.
  if (match.kind === 'SWAP_PROXY') {
    let decoded;
    try {
      decoded = decodeSwapProxyExecute(candidate.data);
    } catch (err) {
      throw new SwapQuoteValidationError(
        `swap tx targets approved SwapProxy ${match.address} but its calldata could not be safely decoded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!isApprovedUniversalRouter(decoded.router, expected.targets)) {
      throw new SwapQuoteValidationError(
        `SwapProxy calldata names router ${decoded.router}, which is NOT an approved Universal Router for chain ${expected.targets.chainId} ` +
          `(approved: [${expected.targets.universalRouters.join(', ') || 'none'}]) -- refusing to sign a proxy call into an unrecognized router`,
      );
    }
    if (decoded.token.toLowerCase() !== expected.tokenIn.toLowerCase()) {
      throw new SwapQuoteValidationError(
        `SwapProxy calldata sells token ${decoded.token}, but this swap was quoted for ${expected.tokenIn} -- refusing to sign a payload for a different asset`,
      );
    }
    if (decoded.amount !== expected.amountInRaw) {
      throw new SwapQuoteValidationError(
        `SwapProxy calldata pulls ${decoded.amount} of the token, but ${expected.amountInRaw} was requested -- refusing to sign a payload for a different amount`,
      );
    }
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

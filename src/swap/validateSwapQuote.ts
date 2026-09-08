import type { Address } from 'viem';
import type { TxRequest } from '../execution/types';

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
 */
export function validateSwapQuote(
  candidate: RawSwapTxCandidate,
  expected: { amountInRaw: bigint; chainId: number; minReceivedRequired: boolean },
): TxRequest {
  if (candidate.chainId !== expected.chainId) {
    throw new SwapQuoteValidationError(`swap tx chainId mismatch: got ${candidate.chainId}, expected ${expected.chainId}`);
  }
  if (!EVM_ADDRESS_RE.test(candidate.to)) {
    throw new SwapQuoteValidationError(`swap tx "to" is not a well-formed EVM address: ${candidate.to}`);
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

  return { to: candidate.to as Address, data: candidate.data as `0x${string}`, value };
}

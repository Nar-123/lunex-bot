import { encodeFunctionData, getAddress, type Address } from 'viem';
import { config } from '../config';
import type { Permit2Grant } from '../blockchain/permit2';

/**
 * OPERATOR-AUTHORISED Permit2 grant renewal -- policy, read-only pre-flight and
 * calldata construction. Nothing in this module sends, signs or schedules
 * anything, and nothing calls it automatically.
 *
 * ## Why `approve`, not `permit`
 *
 * Permit2 offers two ways to create an AllowanceTransfer grant:
 * `permit(owner, PermitSingle, signature)` -- an EIP-712 signature -- and
 * `approve(token, spender, amount, expiration)` -- an ordinary transaction sent
 * by the owner wallet itself. This project deliberately has no EIP-712 signing
 * capability (it is why the Trading API integration sends `x-permit2-disabled`),
 * and introducing one for renewal would add exactly the capability the rest of
 * the design avoids. So: `approve`, from the executor wallet, through the same
 * `executeCriticalTransaction` pipeline as every other write.
 *
 * `approve` does NOT consume or require the grant nonce: that nonce belongs to
 * the signature path and to `invalidateNonces`. A renewal by `approve`
 * increments nothing -- which is itself a post-execution assertion (see
 * `verifyRenewal`).
 *
 * ## What is fixed and what is not
 *
 * owner, token, spender and the Permit2 contract are all taken from verified
 * live chain state plus audited configuration -- never from a request body, a
 * quote, a swap response or any external API. The only operator input is the
 * requested lifetime, and it is clamped by
 * `config.rules.execution.PERMIT2_RENEWAL`.
 */

const RENEWAL = config.rules.execution.PERMIT2_RENEWAL;

/** uint48 max: a grant that never expires. Never constructible through this module. */
export const FORBIDDEN_EXPIRATION = RENEWAL.FORBIDDEN_EXPIRATION;
export const UINT160_MAX = 2n ** 160n - 1n;

/** The confirmation an operator must send verbatim. */
export const PERMIT2_RENEWAL_CONFIRMATION = 'RENEW_PERMIT2_GRANT';

export type Permit2RenewalStatus =
  | 'VALID_CURRENT'
  | 'RENEWAL_NEEDED'
  | 'WRONG_PERMIT2'
  | 'WRONG_OWNER'
  | 'WRONG_TOKEN'
  | 'WRONG_SPENDER'
  | 'INVALID_EXPIRATION'
  | 'UNAVAILABLE';

/** Everything the decision is made from -- all of it read live, none of it cached. */
export interface Permit2RenewalInput {
  /** Chain id read from the live client, compared against the configured chain. */
  chainId: number;
  configuredChainId: number;
  /** The Permit2 the config names. */
  configuredPermit2: Address;
  /** What `PositionManager.permit2()` actually returns, read live. */
  positionManagerPermit2: Address;
  /** The spender settlement really pulls through: the configured PositionManager. */
  positionManagerSpender: Address;
  configuredToken: Address;
  executorOwner: Address;
  /** The exact (owner, token, spender) tuple the grant below was read for. */
  readFor: { owner: Address; token: Address; spender: Address };
  grant: Permit2Grant;
  /** Latest block timestamp, unix seconds. The ONLY clock this module may use. */
  chainTimestamp: number;
  /** Operator-requested lifetime in seconds; omitted means the configured default. */
  requestedLifetimeSeconds?: number;
}

export interface Permit2RenewalTxParams {
  /** Permit2 itself -- the verified contract, never an address from a response. */
  to: Address;
  data: `0x${string}`;
  value: 0n;
  /** Decoded, for the operator to inspect before authorising. */
  call: { token: Address; spender: Address; amount: bigint; expiration: number };
  /** Sender the transaction must be signed by. */
  from: Address;
  chainId: number;
}

export interface Permit2RenewalAssessment {
  status: Permit2RenewalStatus;
  reason: string;
  /** Current grant, as read. */
  current: { amount: bigint; expiration: number; nonce: number };
  chainTimestamp: number;
  secondsUntilExpiry: number;
  /** The grant is close enough to expiry that a renewal is permitted at all. */
  renewalEligible: boolean;
  /** The grant is close enough that an operator should act. */
  renewalRecommended: boolean;
  /** Present ONLY for RENEWAL_NEEDED: what a renewal WOULD send. Never broadcast here. */
  txParams: Permit2RenewalTxParams | null;
  /** Stable identity of this renewal intent -- the idempotency key a future execution uses. */
  idempotencyKey: string | null;
}

export const PERMIT2_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Encodes `Permit2.approve`. Refuses, rather than encodes, anything outside the
 * audited envelope -- so a caller cannot construct a forbidden transaction even
 * by mistake. Pure: no chain access, no clock.
 */
export function encodePermit2Approve(params: { permit2: Address; token: Address; spender: Address; amount: bigint; expiration: number }): { to: Address; data: `0x${string}`; value: 0n } {
  if (params.amount <= 0n || params.amount > UINT160_MAX) throw new Error(`permit2 renewal: amount ${params.amount} outside uint160 range`);
  if (!Number.isInteger(params.expiration) || params.expiration <= 0) throw new Error(`permit2 renewal: expiration ${params.expiration} is not a positive integer`);
  if (params.expiration >= FORBIDDEN_EXPIRATION) throw new Error(`permit2 renewal: refusing uint48-max expiration (a grant that never expires)`);
  return {
    to: getAddress(params.permit2),
    data: encodeFunctionData({
      abi: PERMIT2_APPROVE_ABI,
      functionName: 'approve',
      args: [getAddress(params.token), getAddress(params.spender), params.amount, params.expiration],
    }),
    value: 0n,
  };
}

/** `permit2:renew:<chain>:<token>:<spender>:<expiration>` -- same intent resolves to the same attempt row. */
export function renewalIdempotencyKey(chainId: number, token: Address, spender: Address, expiration: number): string {
  return `permit2:renew:${chainId}:${token.toLowerCase()}:${spender.toLowerCase()}:${expiration}`;
}

/**
 * Read-only assessment. Fails closed on every mismatch, and builds transaction
 * parameters ONLY for `RENEWAL_NEEDED` -- a currently-valid grant never
 * produces a transaction to send.
 */
export function assessPermit2Renewal(i: Permit2RenewalInput): Permit2RenewalAssessment {
  const secondsUntilExpiry = i.grant.expiration - i.chainTimestamp;
  const base = {
    current: { amount: i.grant.amount, expiration: i.grant.expiration, nonce: i.grant.nonce },
    chainTimestamp: i.chainTimestamp,
    secondsUntilExpiry,
    renewalEligible: secondsUntilExpiry <= RENEWAL.ELIGIBLE_WHEN_REMAINING_SECONDS,
    renewalRecommended: secondsUntilExpiry <= RENEWAL.RECOMMEND_WHEN_REMAINING_SECONDS,
    txParams: null,
    idempotencyKey: null,
  };
  const block = (status: Permit2RenewalStatus, reason: string): Permit2RenewalAssessment => ({ ...base, status, reason, renewalEligible: false });

  // ---- identity: every one of these is read live, and any mismatch means the
  // state being judged is not the state a renewal would act on.
  if (i.chainId !== i.configuredChainId) return block('UNAVAILABLE', `live chain id ${i.chainId} != configured ${i.configuredChainId} -- refusing to judge this grant`);
  if (!same(i.positionManagerPermit2, i.configuredPermit2)) {
    return block('WRONG_PERMIT2', `PositionManager is bound to Permit2 ${i.positionManagerPermit2}, not the configured ${i.configuredPermit2} -- refusing to renew`);
  }
  if (!same(i.readFor.owner, i.executorOwner)) return block('WRONG_OWNER', `grant was read for owner ${i.readFor.owner}, but the executor wallet is ${i.executorOwner}`);
  if (!same(i.readFor.token, i.configuredToken)) return block('WRONG_TOKEN', `grant was read for token ${i.readFor.token}, but the configured quote asset is ${i.configuredToken}`);
  if (!same(i.readFor.spender, i.positionManagerSpender)) {
    return block('WRONG_SPENDER', `grant was read for spender ${i.readFor.spender}, but settlement pulls through ${i.positionManagerSpender}`);
  }

  // ---- the requested lifetime
  const lifetime = i.requestedLifetimeSeconds ?? RENEWAL.DEFAULT_LIFETIME_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime <= 0) return block('INVALID_EXPIRATION', `requested lifetime ${lifetime}s is not a positive whole number of seconds`);
  if (lifetime > RENEWAL.MAX_LIFETIME_SECONDS) {
    return block('INVALID_EXPIRATION', `requested lifetime ${lifetime}s exceeds the configured maximum ${RENEWAL.MAX_LIFETIME_SECONDS}s`);
  }
  const expiration = i.chainTimestamp + lifetime;
  if (expiration <= i.chainTimestamp) return block('INVALID_EXPIRATION', `computed expiration ${expiration} is not in the future of chain time ${i.chainTimestamp}`);
  if (expiration >= FORBIDDEN_EXPIRATION) return block('INVALID_EXPIRATION', `computed expiration ${expiration} reaches uint48 max -- a never-expiring grant is refused`);

  // ---- is a renewal warranted at all?
  const stillValid = secondsUntilExpiry > RENEWAL.ELIGIBLE_WHEN_REMAINING_SECONDS;
  if (stillValid) {
    return {
      ...base,
      status: 'VALID_CURRENT',
      reason: `grant is valid for another ${secondsUntilExpiry}s (renewal becomes eligible with ${RENEWAL.ELIGIBLE_WHEN_REMAINING_SECONDS}s remaining) -- no transaction built`,
    };
  }
  if (expiration <= i.grant.expiration + RENEWAL.MIN_IMPROVEMENT_SECONDS) {
    return block('INVALID_EXPIRATION', `a renewal to ${expiration} would not extend the current expiration ${i.grant.expiration} by the required ${RENEWAL.MIN_IMPROVEMENT_SECONDS}s -- refusing a pointless transaction`);
  }

  const amount = UINT160_MAX;
  const { to, data, value } = encodePermit2Approve({ permit2: i.configuredPermit2, token: i.configuredToken, spender: i.positionManagerSpender, amount, expiration });
  return {
    ...base,
    status: 'RENEWAL_NEEDED',
    reason: `grant expires in ${secondsUntilExpiry}s; a renewal would set expiration ${expiration} (chain time ${i.chainTimestamp} + ${lifetime}s)`,
    txParams: { to, data, value, from: i.executorOwner, chainId: i.chainId, call: { token: i.configuredToken, spender: i.positionManagerSpender, amount, expiration } },
    idempotencyKey: renewalIdempotencyKey(i.chainId, i.configuredToken, i.positionManagerSpender, expiration),
  };
}

export interface RenewalVerification {
  ok: boolean;
  reason: string;
}

/**
 * Post-execution verification. Success is NEVER inferred from a receipt: the
 * grant is re-read and every field checked against what was intended.
 *
 * `approve` must not move the nonce, so a changed nonce means something other
 * than this renewal wrote the slot -- reported as a failure, not ignored.
 */
export function verifyRenewal(expected: { owner: Address; token: Address; spender: Address; amount: bigint; expiration: number; nonceBefore: number }, actual: { readFor: { owner: Address; token: Address; spender: Address }; grant: Permit2Grant; chainTimestamp: number }): RenewalVerification {
  if (!same(actual.readFor.owner, expected.owner)) return { ok: false, reason: `verification read owner ${actual.readFor.owner}, expected ${expected.owner}` };
  if (!same(actual.readFor.token, expected.token)) return { ok: false, reason: `verification read token ${actual.readFor.token}, expected ${expected.token}` };
  if (!same(actual.readFor.spender, expected.spender)) return { ok: false, reason: `verification read spender ${actual.readFor.spender}, expected ${expected.spender}` };
  if (actual.grant.amount < expected.amount) return { ok: false, reason: `grant amount ${actual.grant.amount} is below the intended ${expected.amount}` };
  if (actual.grant.expiration !== expected.expiration) return { ok: false, reason: `grant expiration ${actual.grant.expiration} != the intended ${expected.expiration}` };
  if (actual.grant.expiration <= actual.chainTimestamp) return { ok: false, reason: `grant expiration ${actual.grant.expiration} is not in the future of chain time ${actual.chainTimestamp}` };
  if (actual.grant.nonce !== expected.nonceBefore) {
    return { ok: false, reason: `grant nonce moved ${expected.nonceBefore} -> ${actual.grant.nonce}; Permit2.approve must not consume a nonce, so this slot was written by something else` };
  }
  return { ok: true, reason: `grant verified: amount ${actual.grant.amount}, expiration ${actual.grant.expiration}, nonce ${actual.grant.nonce} (unchanged)` };
}

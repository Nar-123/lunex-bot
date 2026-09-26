import { getAddress, type Address } from 'viem';
import { config } from '../config';
import type { Permit2Grant } from '../blockchain/permit2';
import { encodePermit2Approve, FORBIDDEN_EXPIRATION, UINT160_MAX } from '../positions/permit2Renewal';
import { isApprovedUniversalRouter, type ExecutionTargetPolicy } from '../swap/executionTargets';

/**
 * The Permit2 grant an EXIT SWAP needs: `(owner = executor wallet, token =
 * the position's TOKEN, spender = an APPROVED Universal Router)`.
 *
 * ## How this differs from the D5 renewal, and why it is a separate module
 *
 * D5 (`positions/permit2Renewal.ts`) maintains ONE long-lived grant:
 * `USDG -> PositionManager`, which is what settles a v4 MINT. That grant is
 * operator-authorised, renewed rarely, and must not be touched by trading.
 *
 * This is a different grant for a different purpose: short-lived, per-TOKEN,
 * spender = the Universal Router, created automatically as a leg of an exit.
 * Sharing one module would mean one blast radius for two very different
 * authorities, and one idempotency namespace for two lifecycles. They share
 * only the pure calldata encoder and the bounds, which is exactly the part
 * that benefits from being identical.
 *
 * **The existing USDG -> PositionManager grant is never read, written, or
 * used by this module.** Its token is USDG and its spender is the
 * PositionManager; both are refused here.
 *
 * ## Where the spender comes from
 *
 * From `config.uniswapTradingApi.executionTargets.universalRouters` -- the
 * same audited allowlist the swap target is checked against -- and never from
 * a quote, a swap response, or any other API field. A spender that is not on
 * that allowlist is refused rather than approved.
 */

const GRANT = config.rules.exits.PERMIT2_TOKEN_GRANT;

export type TokenGrantStatus = 'VALID' | 'INSUFFICIENT' | 'EXPIRED' | 'WRONG_TOKEN' | 'WRONG_OWNER' | 'WRONG_SPENDER' | 'UNAVAILABLE';

export interface TokenGrantInput {
  /** The exact (owner, token, spender) tuple the grant below was read for. */
  readFor: { owner: Address; token: Address; spender: Address };
  expectedOwner: Address;
  /** The position's TOKEN -- the asset being sold. */
  expectedToken: Address;
  /** Must be on the approved Universal Router allowlist. */
  spender: Address;
  targets: ExecutionTargetPolicy;
  grant: Permit2Grant;
  /** The amount the swap will pull. */
  requiredAmount: bigint;
  /** Latest block timestamp. The ONLY clock used. */
  chainTimestamp: number;
  /** A grant must outlast the swap it is being created for. */
  minRemainingValiditySeconds?: number;
  requestedLifetimeSeconds?: number;
}

export interface TokenGrantAssessment {
  status: TokenGrantStatus;
  reason: string;
  /** true only for INSUFFICIENT/EXPIRED -- the two states an approval leg may fix. */
  needsApproval: boolean;
  current: { amount: bigint; expiration: number; nonce: number };
  secondsUntilExpiry: number;
  /** Present only when `needsApproval` -- exactly what the approval leg would send. */
  approval: { to: Address; data: `0x${string}`; value: 0n; token: Address; spender: Address; amount: bigint; expiration: number } | null;
}

/**
 * Pure assessment. Fails closed on every identity mismatch, and produces
 * approval calldata ONLY for the two states an approval can legitimately fix.
 */
export function assessTokenGrant(i: TokenGrantInput): TokenGrantAssessment {
  const minRemaining = i.minRemainingValiditySeconds ?? GRANT.MIN_REMAINING_VALIDITY_SECONDS;
  const secondsUntilExpiry = i.grant.expiration - i.chainTimestamp;
  const base = {
    current: { amount: i.grant.amount, expiration: i.grant.expiration, nonce: i.grant.nonce },
    secondsUntilExpiry,
    needsApproval: false,
    approval: null,
  };
  const block = (status: TokenGrantStatus, reason: string): TokenGrantAssessment => ({ ...base, status, reason });

  // ---- identity, all of it from live reads + audited config
  if (i.readFor.owner.toLowerCase() !== i.expectedOwner.toLowerCase()) {
    return block('WRONG_OWNER', `grant was read for owner ${i.readFor.owner}, but the executor wallet is ${i.expectedOwner}`);
  }
  if (i.readFor.token.toLowerCase() !== i.expectedToken.toLowerCase()) {
    return block('WRONG_TOKEN', `grant was read for token ${i.readFor.token}, but this exit sells ${i.expectedToken}`);
  }
  if (i.readFor.spender.toLowerCase() !== i.spender.toLowerCase()) {
    return block('WRONG_SPENDER', `grant was read for spender ${i.readFor.spender}, but the swap will be executed by ${i.spender}`);
  }
  // The spender must be an ALLOWLISTED Universal Router -- never an address
  // that merely arrived in a response.
  if (!isApprovedUniversalRouter(i.spender, i.targets)) {
    return block(
      'WRONG_SPENDER',
      `refusing to grant Permit2 authority to ${i.spender}: it is not an approved Universal Router for chain ${i.targets.chainId} ` +
        `(approved: [${i.targets.universalRouters.join(', ') || 'none'}])`,
    );
  }
  // Defence in depth: this module must never touch the entry-side grant.
  if (i.expectedToken.toLowerCase() === config.quoteAsset.ADDRESS.toLowerCase()) {
    return block('WRONG_TOKEN', 'refusing to manage a USDG grant here -- USDG authority belongs to the operator-only renewal path, not to an exit');
  }
  if (i.spender.toLowerCase() === config.uniswap.v4.positionManager.toLowerCase()) {
    return block('WRONG_SPENDER', 'refusing to manage a PositionManager grant here -- that is the operator-only entry grant, not an exit spender');
  }
  if (i.requiredAmount <= 0n) return block('UNAVAILABLE', `required amount ${i.requiredAmount} is not positive -- nothing to authorise`);

  // ---- is the existing grant usable for THIS swap?
  const expired = secondsUntilExpiry < minRemaining;
  const insufficient = i.grant.amount < i.requiredAmount;
  if (!expired && !insufficient) {
    return { ...base, status: 'VALID', reason: `grant covers ${i.grant.amount} until ${i.grant.expiration} (${secondsUntilExpiry}s left) -- no approval needed` };
  }

  // ---- build what an approval leg would send
  const lifetime = i.requestedLifetimeSeconds ?? GRANT.LIFETIME_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime <= 0 || lifetime > GRANT.MAX_LIFETIME_SECONDS) {
    return block('UNAVAILABLE', `requested grant lifetime ${lifetime}s is outside the configured bounds (1..${GRANT.MAX_LIFETIME_SECONDS}s)`);
  }
  const expiration = i.chainTimestamp + lifetime;
  if (expiration >= FORBIDDEN_EXPIRATION) return block('UNAVAILABLE', `computed expiration ${expiration} reaches uint48 max -- a never-expiring grant is refused`);

  const amount: bigint = GRANT.APPROVE_EXACT_AMOUNT ? i.requiredAmount : UINT160_MAX;
  if (amount > UINT160_MAX) return block('UNAVAILABLE', `required amount ${amount} exceeds uint160`);

  const { to, data, value } = encodePermit2Approve({
    permit2: config.uniswap.v4.permit2 as Address,
    token: i.expectedToken,
    spender: i.spender,
    amount,
    expiration,
  });
  const status: TokenGrantStatus = expired ? 'EXPIRED' : 'INSUFFICIENT';
  return {
    ...base,
    status,
    needsApproval: true,
    reason:
      status === 'EXPIRED'
        ? `grant expires in ${secondsUntilExpiry}s, under the ${minRemaining}s an exit swap may need -- an approval leg is required`
        : `grant covers ${i.grant.amount} but the swap pulls ${i.requiredAmount} -- an approval leg is required`,
    approval: { to, data, value, token: getAddress(i.expectedToken), spender: getAddress(i.spender), amount, expiration },
  };
}

/**
 * Idempotency key for the exit-side grant. A DIFFERENT namespace from
 * `permit2:renew:` so an exit can never resume or collide with the
 * operator-only USDG renewal lifecycle.
 *
 * ## What the key identifies: the grant being REPLACED
 *
 * The key is `(close lifecycle, chain, token, spender, the CURRENT on-chain
 * expiration being fixed)` -- deliberately NOT the new expiration:
 *
 *  - the new expiration is derived from chain time, so keying on it would give
 *    a restart at a later block a DIFFERENT key, miss the VERIFIED row, and
 *    send a second approval;
 *  - keying on the attempt counter instead would suppress a genuinely needed
 *    re-approval: a grant that expired during a long-blocked attempt would hit
 *    the cached VERIFIED row and never be renewed.
 *
 * The current expiration is stable across ticks until the approval lands and
 * changes it, so: concurrent exits and restarts reuse ONE attempt, and a later,
 * genuinely new need (a grant that expired again) gets a new one.
 *
 * ## D8 FIX 2: why a retry generation was added
 *
 * Those properties held for every case EXCEPT a definitive failure. A grant
 * approval that fails definitively (reverted, simulation rejected, ...) leaves
 * the on-chain expiration exactly as it was, so the key was unchanged, and
 * `executeCriticalTransaction` returns a FAILED attempt's cached failure
 * forever by design. Every later tick therefore re-derived the same dead key
 * and re-read the same FAILED row: the grant could never be retried, and with
 * it the exit's swap leg could never run again -- a permanently blocked exit
 * from one transient-looking revert.
 *
 * The generation is a suffix, and it is NOT stored on a new column: it is
 * DERIVED from the grant attempts that already exist for this exact prefix
 * (`resolveTokenGrantRetryGeneration`), which is durable state the
 * `TransactionAttempt` table already holds. So it advances only when a
 * definitive FAILED row exists at the current generation, and stays put for a
 * crash, an RPC timeout, SIGNED/SENT/CONFIRMED-not-yet-verified, a restart, or
 * a second concurrent worker -- all of which leave a non-FAILED row.
 */
export function tokenGrantIdempotencyKey(
  closeIdempotencyKey: string,
  chainId: number,
  token: string,
  spender: string,
  replacingExpiration: number,
  retryGeneration = 0,
): string {
  return `${tokenGrantKeyPrefix(closeIdempotencyKey, chainId, token, spender, replacingExpiration)}${retryGeneration}`;
}

/**
 * Everything in the key except the retry generation -- the identity of "this
 * lifecycle's grant replacing THIS on-chain expiration". Used to find the
 * attempts already made for it. Ends with `:r` so it cannot match a different
 * expiration that merely starts with the same digits.
 */
export function tokenGrantKeyPrefix(closeIdempotencyKey: string, chainId: number, token: string, spender: string, replacingExpiration: number): string {
  return `permit2:exit:${closeIdempotencyKey}:${chainId}:${token.toLowerCase()}:${spender.toLowerCase()}:from${replacingExpiration}:r`;
}

/**
 * How many definitive failures in a row are retried before an exit stops
 * asking and waits for an operator. Each generation is one real on-chain
 * approval attempt, and the swap leg's own slippage ladder advances alongside
 * it, so this only has to be generous, not tuned.
 */
export const TOKEN_GRANT_RETRY_GENERATION_LIMIT = 32;

/**
 * The generation THIS tick must use: the lowest one not already occupied by a
 * definitively FAILED attempt. `null` = the limit is reached, which the caller
 * turns into a deferral for an operator rather than an endless retry.
 *
 * Deterministic and read-only, so two concurrent workers reading the same rows
 * always derive the SAME key, and a worker that crashes and restarts re-derives
 * the key it was already using.
 */
export function resolveTokenGrantRetryGeneration(
  attempts: readonly { idempotencyKey: string; status: string }[],
  prefix: string,
  limit: number = TOKEN_GRANT_RETRY_GENERATION_LIMIT,
): number | null {
  const failed = new Set<number>();
  for (const a of attempts) {
    if (a.status !== 'FAILED' || !a.idempotencyKey.startsWith(prefix)) continue;
    const suffix = a.idempotencyKey.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue; // not a generation of this prefix -- ignored, never guessed at
    failed.add(Number(suffix));
  }
  let generation = 0;
  while (failed.has(generation)) generation += 1;
  return generation >= limit ? null : generation;
}

/** The single approved Universal Router an exit may authorise. Fails closed when the allowlist is empty or ambiguous. */
export function exitSwapSpender(targets: ExecutionTargetPolicy): Address {
  const routers = targets.universalRouters;
  if (routers.length !== 1) {
    throw new Error(
      `exit swap spender is ambiguous: chain ${targets.chainId} has ${routers.length} approved Universal Routers [${routers.join(', ') || 'none'}] -- ` +
        'refusing to guess which one to grant Permit2 authority to',
    );
  }
  const only = routers[0];
  if (only === undefined) throw new Error(`exit swap spender missing for chain ${targets.chainId}`);
  return getAddress(only);
}

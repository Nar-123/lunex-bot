import type { Address } from 'viem';
import { executeCriticalTransaction } from '../execution/executeCriticalTransaction';
import type { TransactionAttemptRepository } from '../execution/types';
import { PERMIT2_RENEWAL_CONFIRMATION, type Permit2RenewalAssessment } from './permit2Renewal';
import { buildPermit2RenewalDeps, runPermit2RenewalPreflight, type Permit2RenewalReaders, type Permit2RenewalVerifyData } from './permit2RenewalTx';

/**
 * The one entry point an operator can use to renew the Permit2 grant.
 *
 * Not reachable by the AI supervisor (whose entire surface is the entry-pause
 * flag), not on any schedule, not called by any cycle, and never invoked
 * automatically. It refuses unless the caller is the configured operator, sends
 * the exact confirmation string, and the live pre-flight says a renewal is
 * actually needed.
 *
 * ## Duplicate / concurrent requests
 *
 * The intent is identified by
 * `permit2:renew:<chain>:<token>:<spender>:<expiration>` and executed through
 * `executeCriticalTransaction`, so the existing transaction-attempt
 * infrastructure does the work:
 *
 *  - two simultaneous requests contend for the executor lock; the loser gets
 *    `EXECUTOR_BUSY` and no second transaction is built;
 *  - a repeated request for an attempt already VERIFIED resumes that verified
 *    result instead of sending again;
 *  - an attempt that reached SIGNED (so may already be on the wire) is resumed
 *    by receipt, never re-signed under a fresh nonce;
 *  - an attempt already FAILED is terminal and returns its cached failure;
 *  - a grant that is already valid never reaches execution at all.
 *
 * Because the expiration is part of the key, a genuinely new renewal (a later
 * chain timestamp) is a different attempt -- but it can only be reached once
 * the previous one is terminal, because the pre-flight refuses while the grant
 * is valid, and `MIN_IMPROVEMENT_SECONDS` refuses a pointless re-extension.
 */

export type Permit2RenewalRejectReason =
  | 'NOT_CONFIRMED'
  | 'NOT_AUTHORIZED'
  | 'RENEWAL_NOT_NEEDED'
  | 'PREFLIGHT_BLOCKED'
  | 'PREFLIGHT_UNAVAILABLE';

export type Permit2RenewalActionResult =
  | { outcome: 'REJECTED'; reason: Permit2RenewalRejectReason; detail: string; assessment: Permit2RenewalAssessment | null }
  | { outcome: 'RENEWED'; idempotencyKey: string; assessment: Permit2RenewalAssessment; verified: Permit2RenewalVerifyData }
  | { outcome: 'FAILED'; idempotencyKey: string; assessment: Permit2RenewalAssessment; reason: string; resumable: boolean };

export interface Permit2RenewalRequest {
  confirm: string;
  /** Optional operator-chosen lifetime; the configured default applies when absent. */
  lifetimeSeconds?: number;
  /** Who is asking -- the route has already checked this against the configured operator. */
  actor: string;
  requestId: string;
}

export interface Permit2RenewalDeps {
  txAttempts: TransactionAttemptRepository;
  readers?: Permit2RenewalReaders;
  /** Injectable purely so tests can assert the executor pipeline is used without a chain. */
  execute?: typeof executeCriticalTransaction;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** A dry run: the live assessment and the exact parameters, with nothing sent. Safe to call at any time. */
export async function inspectPermit2Renewal(lifetimeSeconds: number | undefined, deps: Pick<Permit2RenewalDeps, 'readers'> = {}): Promise<Permit2RenewalAssessment> {
  return runPermit2RenewalPreflight(lifetimeSeconds, deps.readers);
}

export async function renewPermit2Grant(request: Permit2RenewalRequest, deps: Permit2RenewalDeps): Promise<Permit2RenewalActionResult> {
  const log = deps.log ?? (() => undefined);
  if (request.confirm !== PERMIT2_RENEWAL_CONFIRMATION) {
    return { outcome: 'REJECTED', reason: 'NOT_CONFIRMED', detail: `renewal requires the exact confirmation "${PERMIT2_RENEWAL_CONFIRMATION}"`, assessment: null };
  }

  // Read EVERYTHING fresh for this request -- nothing is carried over from a
  // previous inspection, so the transaction can only be built from live state.
  const assessment = await runPermit2RenewalPreflight(request.lifetimeSeconds, deps.readers);

  if (assessment.status === 'VALID_CURRENT') {
    return { outcome: 'REJECTED', reason: 'RENEWAL_NOT_NEEDED', detail: assessment.reason, assessment };
  }
  if (assessment.status === 'UNAVAILABLE') {
    return { outcome: 'REJECTED', reason: 'PREFLIGHT_UNAVAILABLE', detail: assessment.reason, assessment };
  }
  if (assessment.status !== 'RENEWAL_NEEDED' || assessment.txParams === null || assessment.idempotencyKey === null) {
    return { outcome: 'REJECTED', reason: 'PREFLIGHT_BLOCKED', detail: `[${assessment.status}] ${assessment.reason}`, assessment };
  }

  const key = assessment.idempotencyKey;
  log('permit2_renewal_authorized', {
    actor: request.actor,
    requestId: request.requestId,
    idempotencyKey: key,
    spender: assessment.txParams.call.spender,
    expiration: assessment.txParams.call.expiration,
    currentExpiration: assessment.current.expiration,
    chainTimestamp: assessment.chainTimestamp,
  });

  const execute = deps.execute ?? executeCriticalTransaction;
  const result = await execute<Permit2RenewalVerifyData>(
    key,
    'permit2:renew',
    buildPermit2RenewalDeps(assessment.txParams, assessment.current.nonce, deps.readers),
    deps.txAttempts,
    { log: (event, data) => { log(event, data); } },
  );

  if (result.ok) {
    log('permit2_renewal_verified', { actor: request.actor, requestId: request.requestId, idempotencyKey: key, ...result.data });
    return { outcome: 'RENEWED', idempotencyKey: key, assessment, verified: result.data };
  }
  log('permit2_renewal_failed', { actor: request.actor, requestId: request.requestId, idempotencyKey: key, reason: result.reason, resumable: result.resumable });
  return { outcome: 'FAILED', idempotencyKey: key, assessment, reason: result.reason, resumable: result.resumable };
}

/** Exposed for the route's response shaping. */
export function assessmentToJson(a: Permit2RenewalAssessment): Record<string, unknown> {
  return {
    status: a.status,
    reason: a.reason,
    chainTimestamp: a.chainTimestamp,
    currentExpiration: a.current.expiration,
    currentExpirationIso: new Date(a.current.expiration * 1000).toISOString(),
    currentAmount: a.current.amount.toString(),
    currentNonce: a.current.nonce,
    secondsUntilExpiry: a.secondsUntilExpiry,
    renewalEligible: a.renewalEligible,
    renewalRecommended: a.renewalRecommended,
    idempotencyKey: a.idempotencyKey,
    wouldSend:
      a.txParams === null
        ? null
        : {
            to: a.txParams.to,
            from: a.txParams.from,
            chainId: a.txParams.chainId,
            value: '0',
            data: a.txParams.data,
            decoded: {
              function: 'approve(address token,address spender,uint160 amount,uint48 expiration)',
              token: a.txParams.call.token,
              spender: a.txParams.call.spender,
              amount: a.txParams.call.amount.toString(),
              expiration: a.txParams.call.expiration,
              expirationIso: new Date(a.txParams.call.expiration * 1000).toISOString(),
            },
          },
  };
}

export type { Address };

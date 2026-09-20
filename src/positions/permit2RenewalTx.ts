import type { Address } from 'viem';
import { config } from '../config';
import { getPublicClient } from '../blockchain/viemClient';
import { getExecutorAddress } from '../blockchain/walletClient';
import { readChainTimestamp, readPermit2Grant, readPositionManagerPermit2, type Permit2Grant } from '../blockchain/permit2';
import type { TxSafetyDeps } from '../execution/types';
import * as txSteps from '../execution/viemTxSteps';
import {
  assessPermit2Renewal,
  verifyRenewal,
  type Permit2RenewalAssessment,
  type Permit2RenewalTxParams,
} from './permit2Renewal';

/**
 * The live side of operator-authorised Permit2 renewal: one read-only
 * pre-flight that reads EVERY input fresh, and a `TxSafetyDeps` builder that
 * hands a renewal to the existing `executeCriticalTransaction` pipeline.
 *
 * Nothing here runs on a timer, on a cycle, or on startup. The only callers are
 * the operator route (`api/routes/permit2Renew.ts`) and tests.
 *
 * Deliberately a separate module from `permit2Preflight.ts`: that module stays
 * strictly read-only with no transaction construction at all, which
 * `tests/positions/permit2ExpiryAudit.test.ts` enforces by scanning its source.
 */

export interface Permit2RenewalReaders {
  readChainId?: () => Promise<number>;
  readPositionManagerPermit2?: (positionManager: Address) => Promise<Address>;
  readPermit2Grant?: (permit2: Address, owner: Address, token: Address, spender: Address) => Promise<Permit2Grant>;
  readChainTimestamp?: () => Promise<number>;
  walletAddress?: Address;
}

/**
 * Reads all ten required values live and assesses them. Nothing is cached
 * between calls: a future execution request re-runs this and builds its
 * transaction only from what it just read.
 *
 * Fails closed -- any read that throws propagates, and is never interpreted as
 * "no grant" or "valid".
 */
export async function runPermit2RenewalPreflight(requestedLifetimeSeconds: number | undefined, r: Permit2RenewalReaders = {}): Promise<Permit2RenewalAssessment> {
  const owner = r.walletAddress ?? getExecutorAddress();
  const token = config.quoteAsset.ADDRESS as Address;
  const permit2 = config.uniswap.v4.permit2 as Address;
  const positionManager = config.uniswap.v4.positionManager as Address;

  const [chainId, positionManagerPermit2, grant, chainTimestamp] = await Promise.all([
    (r.readChainId ?? (() => getPublicClient().getChainId()))(),
    (r.readPositionManagerPermit2 ?? readPositionManagerPermit2)(positionManager),
    (r.readPermit2Grant ?? readPermit2Grant)(permit2, owner, token, positionManager),
    (r.readChainTimestamp ?? readChainTimestamp)(),
  ]);

  return assessPermit2Renewal({
    chainId,
    configuredChainId: config.chain.chainId,
    configuredPermit2: permit2,
    positionManagerPermit2,
    positionManagerSpender: positionManager,
    configuredToken: token,
    executorOwner: owner,
    readFor: { owner, token, spender: positionManager },
    grant,
    chainTimestamp,
    requestedLifetimeSeconds,
  });
}

export interface Permit2RenewalVerifyData {
  amount: string;
  expiration: number;
  nonce: number;
}

/**
 * `TxSafetyDeps` for a renewal, for the existing executor pipeline: the same
 * gas policy, fee headroom, cap, nonce safety, signing checkpoint and error
 * handling as every other critical transaction. No separate gas strategy.
 *
 * `verifyOnChain` never trusts the receipt: it re-reads the grant and requires
 * every field to match the intent, including that the nonce did NOT move.
 */
export function buildPermit2RenewalDeps(params: Permit2RenewalTxParams, nonceBefore: number, r: Permit2RenewalReaders = {}): TxSafetyDeps<Permit2RenewalVerifyData> {
  const owner = r.walletAddress ?? getExecutorAddress();
  const permit2 = config.uniswap.v4.permit2 as Address;
  const readGrant = r.readPermit2Grant ?? readPermit2Grant;
  const readTime = r.readChainTimestamp ?? readChainTimestamp;

  return {
    // The calldata was built by the pre-flight from live state and is passed in
    // verbatim -- this step never re-derives a target or a spender.
    buildTransaction: () => Promise.resolve({ to: params.to, data: params.data, value: 0n }),
    simulate: txSteps.simulateTx,
    estimateGas: txSteps.estimateGasForTx,
    getGasPrice: txSteps.getCurrentGasPrice,
    checkGasAffordable: txSteps.checkGasAffordableOnChain,
    getNonce: txSteps.getCurrentNonce,
    signTransaction: txSteps.signTx,
    broadcastRaw: txSteps.broadcastRawTx,
    waitForReceipt: txSteps.waitForTxReceipt,
    getReceiptIfAvailable: txSteps.getReceiptIfAvailable,
    verifyOnChain: async () => {
      const [grant, chainTimestamp] = await Promise.all([readGrant(permit2, owner, params.call.token, params.call.spender), readTime()]);
      const v = verifyRenewal(
        { owner, token: params.call.token, spender: params.call.spender, amount: params.call.amount, expiration: params.call.expiration, nonceBefore },
        { readFor: { owner, token: params.call.token, spender: params.call.spender }, grant, chainTimestamp },
      );
      if (!v.ok) return { ok: false, reason: v.reason };
      return { ok: true, data: { amount: grant.amount.toString(), expiration: grant.expiration, nonce: grant.nonce } };
    },
  };
}

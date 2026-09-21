import type { Address } from 'viem';
import { config } from '../config';
import { getExecutorAddress } from '../blockchain/walletClient';
import { readChainTimestamp, readPermit2Grant, type Permit2Grant } from '../blockchain/permit2';
import type { TxSafetyDeps } from '../execution/types';
import * as txSteps from '../execution/viemTxSteps';
import { assessTokenGrant, exitSwapSpender, type TokenGrantAssessment } from './permit2TokenGrant';

/**
 * The exit-side Permit2 approval leg: a critical transaction like any other
 * (same gas policy, nonce safety, SIGNED checkpoint, receipt recovery,
 * idempotency, verify-by-re-read). Its own simulation, like the swap's, is the
 * executor's persisted-txRequest simulation -- nothing here duplicates it.
 */

export interface TokenGrantReaders {
  readPermit2Grant?: (permit2: Address, owner: Address, token: Address, spender: Address) => Promise<Permit2Grant>;
  readChainTimestamp?: () => Promise<number>;
  walletAddress?: Address;
}

/**
 * Reads the live grant and assesses it. Every input is read fresh; a read that
 * throws propagates rather than being interpreted as "no grant".
 */
export async function runTokenGrantPreflight(token: Address, requiredAmount: bigint, r: TokenGrantReaders = {}): Promise<TokenGrantAssessment> {
  const owner = r.walletAddress ?? getExecutorAddress();
  const permit2 = config.uniswap.v4.permit2 as Address;
  const targets = config.uniswapTradingApi.executionTargets;
  const spender = exitSwapSpender(targets);
  const [grant, chainTimestamp] = await Promise.all([
    (r.readPermit2Grant ?? readPermit2Grant)(permit2, owner, token, spender),
    (r.readChainTimestamp ?? readChainTimestamp)(),
  ]);
  return assessTokenGrant({
    readFor: { owner, token, spender },
    expectedOwner: owner,
    expectedToken: token,
    spender,
    targets,
    grant,
    requiredAmount,
    chainTimestamp,
  });
}

export interface TokenGrantVerifyData {
  amount: string;
  expiration: number;
  nonce: number;
}

/**
 * `TxSafetyDeps` for the approval leg. `verifyOnChain` never trusts the
 * receipt: it re-reads the grant and requires it to actually cover the swap.
 */
export function buildTokenGrantDeps(
  approval: { to: Address; data: `0x${string}`; token: Address; spender: Address; amount: bigint; expiration: number },
  requiredAmount: bigint,
  r: TokenGrantReaders = {},
): TxSafetyDeps<TokenGrantVerifyData> {
  const owner = r.walletAddress ?? getExecutorAddress();
  const permit2 = config.uniswap.v4.permit2 as Address;
  const readGrant = r.readPermit2Grant ?? readPermit2Grant;
  const readTime = r.readChainTimestamp ?? readChainTimestamp;

  return {
    buildTransaction: () => Promise.resolve({ to: approval.to, data: approval.data, value: 0n }),
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
      const [grant, now] = await Promise.all([readGrant(permit2, owner, approval.token, approval.spender), readTime()]);
      if (grant.amount < requiredAmount) {
        return { ok: false, reason: `Permit2 grant for ${approval.token} is ${grant.amount}, below the ${requiredAmount} this swap pulls` };
      }
      if (grant.expiration !== approval.expiration) {
        return { ok: false, reason: `Permit2 grant expiration is ${grant.expiration}, not the intended ${approval.expiration}` };
      }
      if (grant.expiration <= now) {
        return { ok: false, reason: `Permit2 grant expiration ${grant.expiration} is not in the future of chain time ${now}` };
      }
      return { ok: true, data: { amount: grant.amount.toString(), expiration: grant.expiration, nonce: grant.nonce } };
    },
  };
}

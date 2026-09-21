import type { Address } from 'viem';
import { config } from '../config';
import { getPublicClient } from '../blockchain/viemClient';
import { getExecutorAddress } from '../blockchain/walletClient';
import { readChainTimestamp, readPermit2Grant, type Permit2Grant } from '../blockchain/permit2';
import type { TxRequest, TxSafetyDeps } from '../execution/types';
import * as txSteps from '../execution/viemTxSteps';
import { assessTokenGrant, exitSwapSpender, type TokenGrantAssessment } from './permit2TokenGrant';

/**
 * The exit-side Permit2 approval leg, and the pre-swap simulation gate.
 *
 * Both are ordinary members of the existing execution model: the approval is a
 * critical transaction like any other (same gas policy, nonce safety, SIGNED
 * checkpoint, receipt recovery, idempotency, verify-by-re-read), and the
 * simulation is a read-only `eth_call` that runs BEFORE any signing decision.
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

export type SimulationOutcome = { ok: true } | { ok: false; reason: string };

/**
 * PART 9 -- the strict simulation gate.
 *
 * Runs the exact calldata that would be signed through `eth_call` first. A
 * revert here means the transaction would fail on-chain: it is refused before
 * a nonce is taken or anything is signed, rather than discovered after paying
 * gas. This is what would have caught the original exit-router incident.
 *
 * Read-only: `eth_call` changes no state and broadcasts nothing.
 */
export async function simulateExitSwap(
  tx: TxRequest,
  from: Address,
  call: (args: { account: Address; to: Address; data: `0x${string}`; value: bigint }) => Promise<unknown> = (args) => getPublicClient().call(args),
): Promise<SimulationOutcome> {
  try {
    await call({ account: from, to: tx.to, data: tx.data, value: tx.value });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? (('shortMessage' in err && typeof err.shortMessage === 'string' ? err.shortMessage : err.message)) : String(err);
    return { ok: false, reason: message.slice(0, 400) };
  }
}

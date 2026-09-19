import { keccak256, TransactionReceiptNotFoundError } from 'viem';
import type { LocalAccount } from 'viem';
import { getPublicClient } from '../blockchain/viemClient';
import { getExecutorAccount, getExecutorAddress } from '../blockchain/walletClient';
import { robinhoodChain } from '../blockchain/viemChain';
import { checkGasAffordability } from './gasAffordability';
import type { StepResult, TxRequest } from './types';

/**
 * Real on-chain implementations of each `TxSafetyDeps` step, using the
 * viem clients from `blockchain/`. These are the pieces that genuinely
 * need a live RPC connection to fully verify -- unlike
 * `executeCriticalTransaction`'s state-machine logic (fully unit-tested
 * with injected mocks), these are correct-by-inspection and flagged for
 * verification against Robinhood Chain before real funds are at risk,
 * consistent with how every other live-RPC integration in this project
 * has been handled.
 */

/**
 * H2 fix: distinguishes a genuine on-chain simulation revert (a
 * DEFINITIVE fact about this exact transaction, safe to mark
 * SIMULATION_REJECTED/FAILED) from a transient/ambiguous RPC or transport
 * failure (timeout, 429, 500, connection reset, provider unavailable, or
 * literally anything else) -- which must NEVER be treated as a definitive
 * rejection, only ever resumable. Conservative by design, mirroring
 * `classifyBroadcastError.ts`'s philosophy exactly: only an unambiguous
 * on-chain fact is classified as DEFINITIVE, and the single positive
 * signal used here is the substring "revert" -- the word viem/EVM nodes
 * use specifically and only for genuine execution reverts ("execution
 * reverted", "reverted with reason string ...", "reverted with custom
 * error ..."), never for a network/transport failure. Every other
 * message, including one this function has never seen before, defaults
 * to TRANSIENT -- never the other way around.
 */
export function isDefinitiveSimulationRevert(message: string): boolean {
  return message.toLowerCase().includes('revert');
}

export async function simulateTx(tx: TxRequest): Promise<StepResult> {
  const client = getPublicClient();
  try {
    await client.call({ account: getExecutorAddress(), to: tx.to, data: tx.data, value: tx.value });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDefinitiveSimulationRevert(message)) {
      return { ok: false, reason: message };
    }
    // Transient/ambiguous (RPC timeout, 429, 500, connection reset,
    // provider unavailable, or anything unrecognized) -- rethrow so
    // executeCriticalTransaction's outer catch treats this as resumable,
    // never a definitive SIMULATION_REJECTED.
    throw err instanceof Error ? err : new Error(message);
  }
}

export async function estimateGasForTx(tx: TxRequest): Promise<bigint> {
  const client = getPublicClient();
  return client.estimateGas({ account: getExecutorAddress(), to: tx.to, data: tx.data, value: tx.value });
}

export async function getCurrentGasPrice(): Promise<bigint> {
  const client = getPublicClient();
  return client.getGasPrice();
}

export async function checkGasAffordableOnChain(gasLimit: bigint, gasPrice: bigint): Promise<StepResult> {
  const client = getPublicClient();
  const ethBalance = await client.getBalance({ address: getExecutorAddress() });
  return checkGasAffordability(gasLimit, gasPrice, ethBalance);
}

/** Pending-inclusive nonce -- counts transactions already in the mempool, not just mined ones, so back-to-back critical transactions never collide. */
export async function getCurrentNonce(): Promise<number> {
  const client = getPublicClient();
  return client.getTransactionCount({ address: getExecutorAddress(), blockTag: 'pending' });
}

/**
 * Signs LOCALLY with the executor's private-key account -- pure computation,
 * no network I/O, so it cannot hang and a throw is deterministic.
 *
 * Incident fix: this used to call `walletClient.signTransaction({ account:
 * getExecutorAddress(), ... })`. viem's `parseAccount` turns an address
 * STRING into a JSON-RPC account (no local signer), so viem ignored the
 * local key and sent `eth_signTransaction` to the RPC node -- which a hosted
 * RPC cannot serve. Every critical transaction therefore failed at the
 * signing step (after NONCE_ASSIGNED, before SIGNED) and nothing was ever
 * signed or broadcast. It also made an RPC round-trip (`eth_chainId`) inside
 * the executor lock; local signing removes both.
 *
 * `chainId` is the configured chain (EIP-155 replay protection binds the
 * signature to it; a mismatched RPC would reject the broadcast outright).
 * `type: 'legacy'` is what viem inferred for this exact field set before
 * (gasPrice, no EIP-1559 fees) -- same payload shape as before the fix.
 */
export async function signTxWithAccount(
  account: Pick<LocalAccount, 'signTransaction'>,
  chainId: number,
  tx: TxRequest,
  nonce: number,
  gasLimit: bigint,
  gasPrice: bigint,
): Promise<{ raw: `0x${string}`; hash: `0x${string}` }> {
  const raw = await account.signTransaction({
    type: 'legacy',
    chainId,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    nonce,
    gas: gasLimit,
    gasPrice,
  });
  // The transaction hash is deterministic from the signed payload itself
  // -- computed here, BEFORE broadcasting, specifically so a broadcast
  // that throws/times out still leaves us knowing exactly what hash to
  // look up on resume.
  const hash = keccak256(raw);
  return { raw, hash };
}

export async function signTx(
  tx: TxRequest,
  nonce: number,
  gasLimit: bigint,
  gasPrice: bigint,
): Promise<{ raw: `0x${string}`; hash: `0x${string}` }> {
  return signTxWithAccount(getExecutorAccount(), robinhoodChain.id, tx, nonce, gasLimit, gasPrice);
}

export async function broadcastRawTx(raw: `0x${string}`): Promise<void> {
  const client = getPublicClient();
  await client.sendRawTransaction({ serializedTransaction: raw });
}

export async function waitForTxReceipt(hash: `0x${string}`): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint }> {
  const client = getPublicClient();
  const receipt = await client.waitForTransactionReceipt({ hash });
  return { status: receipt.status, blockNumber: receipt.blockNumber };
}

/**
 * A SINGLE, non-blocking lookup (unlike `waitForTxReceipt`, which polls
 * until mined or timeout) -- returns `null` if the transaction hasn't
 * been mined yet, rather than waiting. Used to disambiguate a "nonce too
 * low" / "replacement transaction underpriced" broadcast rejection: only
 * a genuine "not found" means null here; any other failure (RPC error)
 * propagates so the caller doesn't mistake "couldn't check" for "not
 * mined."
 */
export async function getReceiptIfAvailable(
  hash: `0x${string}`,
): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint } | null> {
  const client = getPublicClient();
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    return { status: receipt.status, blockNumber: receipt.blockNumber };
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) {
      return null;
    }
    throw err;
  }
}

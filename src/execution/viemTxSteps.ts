import { keccak256, TransactionReceiptNotFoundError } from 'viem';
import { getPublicClient } from '../blockchain/viemClient';
import { getWalletClient, getExecutorAddress } from '../blockchain/walletClient';
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

export async function simulateTx(tx: TxRequest): Promise<StepResult> {
  const client = getPublicClient();
  try {
    await client.call({ account: getExecutorAddress(), to: tx.to, data: tx.data, value: tx.value });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
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

export async function signTx(
  tx: TxRequest,
  nonce: number,
  gasLimit: bigint,
  gasPrice: bigint,
): Promise<{ raw: `0x${string}`; hash: `0x${string}` }> {
  const walletClient = getWalletClient();
  const raw = await walletClient.signTransaction({
    account: getExecutorAddress(),
    chain: robinhoodChain,
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

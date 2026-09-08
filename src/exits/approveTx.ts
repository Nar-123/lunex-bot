import type { Address } from 'viem';
import { encodeErc20Approve, readErc20Allowance } from '../blockchain/erc20';
import { getExecutorAddress } from '../blockchain/walletClient';
import type { TxSafetyDeps } from '../execution/types';
import * as txSteps from '../execution/viemTxSteps';

export interface ApproveVerifyData {
  allowanceRaw: bigint;
}

export interface BuildApproveDepsOptions {
  /** Injectable for tests -- defaults to the real on-chain ERC20 allowance read. */
  readAllowance?: (tokenAddress: Address, owner: Address, spender: Address) => Promise<bigint>;
  /** Injectable for tests -- defaults to the real configured executor wallet. */
  walletAddress?: Address;
}

/**
 * A conditional third leg of the exit flow, needed only when
 * `SwapQuote.allowanceTarget` is non-null: an ordinary ERC20 `approve()`
 * transaction, run through the exact same `executeCriticalTransaction`
 * pipeline as remove-liquidity and the swap itself.
 *
 * This exists specifically because Permit2 (the alternative the Trading
 * API would otherwise want) requires an off-chain EIP-712 SIGNATURE, not a
 * transaction -- a capability this project has never needed and doesn't
 * implement (every other integration point signs and broadcasts real
 * transactions through Module 6's pipeline). Rather than half-build
 * EIP-712 signing as a one-off special case, `swap/tradingApiClient.ts`
 * explicitly asks the API to disable Permit2, and this ordinary
 * `approve()` is what stands in for it -- consistent with the rest of the
 * codebase's "everything critical is a signed+broadcast+verified
 * transaction" architecture, and Permit2's "no permitData" contract is
 * independently re-verified in `swap/tradingApiMapper.ts` regardless of
 * this choice (never trusted just because it was requested).
 *
 * Approves for exactly `amountInRaw` (the amount this specific swap
 * attempt needs), not an infinite/unbounded allowance -- a fresh exit
 * attempt (new `swapAttemptCount`) that needs a different amount gets its
 * own fresh approve check rather than relying on a stale, possibly
 * insufficient prior approval.
 */
export function buildApproveDeps(
  tokenAddress: Address,
  spender: Address,
  amountInRaw: bigint,
  options: BuildApproveDepsOptions = {},
): TxSafetyDeps<ApproveVerifyData> {
  const readAllowance = options.readAllowance ?? readErc20Allowance;
  const wallet = options.walletAddress ?? getExecutorAddress();

  return {
    buildTransaction: async () => {
      const { to, data } = encodeErc20Approve(tokenAddress, spender, amountInRaw);
      return { to, data, value: 0n };
    },
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
      const allowanceRaw = await readAllowance(tokenAddress, wallet, spender);
      if (allowanceRaw < amountInRaw) {
        return { ok: false, reason: `allowance is only ${allowanceRaw}, need at least ${amountInRaw}` };
      }
      return { ok: true, data: { allowanceRaw } };
    },
  };
}

/** Pure check: is an approve transaction even necessary, given the current on-chain allowance? Kept separate from `buildApproveDeps` so `executeExit.ts` can decide whether to run the approve leg at all without needing a full `TxSafetyDeps` object just to ask. */
export function needsApproval(currentAllowanceRaw: bigint, amountInRaw: bigint): boolean {
  return currentAllowanceRaw < amountInRaw;
}

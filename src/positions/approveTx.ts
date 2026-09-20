import type { Address } from 'viem';
import { config } from '../config';
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
 * A conditional first leg of the open-position flow: an ordinary USDG
 * `approve()` for **Permit2** -- the contract that actually moves the USDG
 * when the v4 PositionManager settles a mint (`SETTLE_PAIR` ->
 * `permit2.transferFrom`). VERIFIED on the first live mint: the direct
 * ERC20 allowance to the PositionManager was never consumed; the one to
 * Permit2 dropped by exactly the deposit. Approving the PositionManager
 * (the previous behaviour) left an unused allowance and did not provide
 * what the mint needs. The separate Permit2 -> PositionManager grant is NOT
 * created here (see `permit2Preflight.ts`). Same pattern as
 * `exits/approveTx.ts` -- deliberately NOT shared code between the two
 * modules (positions/ and exits/ each own their tx-builders, matching this
 * project's established per-module convention, and importing one from the
 * other would create a circular dependency between positions/ and exits/,
 * which already depends on positions/ for `PositionRepository`).
 *
 * Unlike `exits/approveTx.ts`, the spender here is always the (fixed,
 * configured) Permit2 address, and the token is always USDG --
 * both fixed by this module's purpose, not passed in as parameters.
 *
 * Approves for exactly `amountInRaw` (this deployment's decided position
 * size), not an infinite/unbounded allowance -- consistent with the same
 * "approve exactly what's needed, nothing more" choice `exits/approveTx.ts`
 * makes.
 */
export function buildApproveDeps(amountInRaw: bigint, options: BuildApproveDepsOptions = {}): TxSafetyDeps<ApproveVerifyData> {
  const readAllowance = options.readAllowance ?? readErc20Allowance;
  const wallet = options.walletAddress ?? getExecutorAddress();
  const usdgAddress = config.quoteAsset.ADDRESS as Address;
  const permit2Address = config.uniswap.v4.permit2 as Address;

  return {
    buildTransaction: () => {
      const { to, data } = encodeErc20Approve(usdgAddress, permit2Address, amountInRaw);
      return Promise.resolve({ to, data, value: 0n });
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
      const allowanceRaw = await readAllowance(usdgAddress, wallet, permit2Address);
      if (allowanceRaw < amountInRaw) {
        return { ok: false, reason: `USDG allowance for Permit2 is only ${allowanceRaw}, need at least ${amountInRaw}` };
      }
      return { ok: true, data: { allowanceRaw } };
    },
  };
}

/** Pure check: is an approve transaction even necessary, given the current on-chain allowance? Same helper shape as `exits/approveTx.ts`'s. */
export function needsApproval(currentAllowanceRaw: bigint, amountInRaw: bigint): boolean {
  return currentAllowanceRaw < amountInRaw;
}

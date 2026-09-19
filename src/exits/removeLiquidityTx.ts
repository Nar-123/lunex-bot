import { getAddress } from 'viem';
import type { Address } from 'viem';
import { Percent, Token } from '@uniswap/sdk-core';
import { v4Sdk } from '../blockchain/uniswapSdk';
import { config } from '../config';
import { readErc20TransfersTo } from '../blockchain/erc20';
import { getExecutorAddress } from '../blockchain/walletClient';
import type { TxSafetyDeps } from '../execution/types';
import * as txSteps from '../execution/viemTxSteps';
import type { PositionRecord } from '../positions/types';
import type { LivePositionStateProvider, PoolPriceProvider } from '../monitoring/types';

const DEADLINE_WINDOW_SECONDS = 10 * 60; // 10 minutes from build time -- generous enough to survive the SIMULATED/GAS_CHECKED/SIGNED steps, short enough that a very stale resumed attempt fails loudly instead of executing against a long-gone price

/**
 * VALIDATION PHASE: `liquidityZero` proves the burn happened; `usdgProceedsRaw` is the USDG the SAME confirmed transaction paid the wallet (realized-PnL measurement).
 *
 * H1 fix: `tokenProceedsRaw` is the position's TOKEN the SAME confirmed
 * transaction paid the wallet, read from the SAME receipt with the SAME
 * receipt-scoped decoder. It is what lets `executeExit.ts` tell a genuine
 * USDG-only close (a one-sided USDG position that never traded into its
 * range -- the strategy's normal "never filled" lifecycle -- whose burn
 * pays out exactly 0 TOKEN) apart from a close that SHOULD have left TOKEN
 * to swap. Before this field existed, the exit flow inferred "is there
 * TOKEN to swap" from the live wallet balance and treated 0 as an
 * invariant violation, stranding every never-filled position at CLOSING.
 * Optional ONLY because attempts VERIFIED by an older build persisted
 * verifyData without it; every new verification always sets it.
 */
export interface RemoveLiquidityVerifyData {
  liquidityZero: true;
  usdgProceedsRaw: bigint;
  tokenProceedsRaw?: bigint;
}

export interface BuildRemoveLiquidityDepsOptions {
  /** Injectable for tests -- defaults to the real receipt-log decoder (`blockchain/erc20.ts`'s `readErc20TransfersTo`). */
  readUsdgTransfersTo?: (txHash: `0x${string}`, tokenAddress: Address, walletAddress: Address) => Promise<bigint>;
  /** Injectable for tests -- defaults to the real configured executor wallet. */
  walletAddress?: Address;
}

/**
 * Same construction pattern as `monitoring/computePositionMetrics.ts` -- real `Token` entities (not placeholders), since the v4 SDK's `Position`/`Pool` classes call real methods on them (`.isNative`, `.equals()`, etc.), not just read `.address`.
 *
 * Exported (Phase 12G) purely so `tests/exits/removeLiquidityTx.test.ts` can
 * assert the constructed USDG `Token`'s `.decimals` directly matches
 * `config.quoteAsset.DECIMALS` -- not a new abstraction, the function
 * already existed, only its visibility changed.
 */
export function buildV4Position(position: PositionRecord, liquidity: bigint, sqrtPriceX96: bigint, tickCurrent: number) {
  const usdgAddress = getAddress(config.quoteAsset.ADDRESS);
  const currency0Address = getAddress(position.pool.currency0);
  const currency1Address = getAddress(position.pool.currency1);
  const usdgIsCurrency0 = currency0Address === usdgAddress;

  const usdgToken = new Token(config.chain.chainId, usdgIsCurrency0 ? currency0Address : currency1Address, config.quoteAsset.DECIMALS, 'USDG');
  const otherToken = new Token(
    config.chain.chainId,
    usdgIsCurrency0 ? currency1Address : currency0Address,
    position.tokenDecimals,
    position.tokenSymbol,
  );
  const currency0Token = usdgIsCurrency0 ? usdgToken : otherToken;
  const currency1Token = usdgIsCurrency0 ? otherToken : usdgToken;

  const pool = new v4Sdk.Pool(
    currency0Token,
    currency1Token,
    position.pool.fee,
    position.pool.tickSpacing,
    position.pool.hooks,
    sqrtPriceX96.toString(),
    '0',
    tickCurrent,
  );
  return new v4Sdk.Position({ pool, liquidity: liquidity.toString(), tickLower: position.tickLower, tickUpper: position.tickUpper });
}

/**
 * Tx A of the exit flow: REMOVE_LIQUIDITY + COLLECT_FEES, as ONE on-chain
 * transaction. Uses `@uniswap/v4-sdk`'s `V4PositionManager.removeCallParameters`
 * directly (already exposed via `blockchain/uniswapSdk.ts`) -- NOT a
 * hand-rolled Actions encoding, and NOT UniversalRouter (the router
 * modification issue that ruled out manual UniversalRouter calldata is
 * specific to UniversalRouter, not PositionManager).
 *
 * Verified by reading the SDK source directly (`PositionManager.js`): with
 * `burnToken: true` at `liquidityPercentage` 100%, `removeCallParameters`
 * encodes `BURN_POSITION` + `TAKE_PAIR` in one multicall -- `TAKE_PAIR`
 * settles BOTH the withdrawn principal AND any accrued-but-uncollected fees
 * together. So the spec's two flow steps ("Remove Liquidity" then "Collect
 * Fees") map onto this ONE transaction / ONE `executeCriticalTransaction`
 * call, not two -- a deliberate flow-steps-to-transactions mapping
 * decision, not a shortcut.
 *
 * `slippageTolerance` is `config.rules.exits.REMOVE_LIQUIDITY_SLIPPAGE_BPS`
 * (P1-11 fix -- was 100%/no minimum `amount0Min`/`amount1Min` at all; see
 * that constant's doc comment for why 100 bps, not an invented number).
 * `liquidityPercentage` below is UNRELATED and unchanged -- it means
 * "remove 100% of this position's liquidity" (a full close), not a
 * slippage bound.
 *
 * `verifyOnChain` re-reads live position state and confirms liquidity is
 * genuinely 0 -- proving the burn actually happened on-chain, not just
 * that the transaction didn't revert.
 */
export function buildRemoveLiquidityDeps(
  position: PositionRecord,
  livePositionState: LivePositionStateProvider,
  poolPrice: PoolPriceProvider,
  options: BuildRemoveLiquidityDepsOptions = {},
): TxSafetyDeps<RemoveLiquidityVerifyData> {
  const positionManagerAddress = config.uniswap.v4.positionManager as `0x${string}`;
  const readUsdgTransfersTo = options.readUsdgTransfersTo ?? readErc20TransfersTo;
  const wallet = options.walletAddress ?? getExecutorAddress();
  const usdgAddress = config.quoteAsset.ADDRESS as Address;

  return {
    buildTransaction: async () => {
      const [live, price] = await Promise.all([livePositionState.getLiveState(position), poolPrice.getPriceState(position.pool)]);
      if (live.liquidity <= 0n) {
        throw new Error(`cannot build remove-liquidity tx: position ${position.id} has no live liquidity (already removed?)`);
      }
      if (!position.positionTokenId) {
        throw new Error(`cannot build remove-liquidity tx: position ${position.id} has no positionTokenId recorded`);
      }
      const sdkPosition = buildV4Position(position, live.liquidity, price.sqrtPriceX96, price.tickCurrent);
      const deadline = Math.floor(Date.now() / 1000) + DEADLINE_WINDOW_SECONDS;
      const { calldata, value } = v4Sdk.V4PositionManager.removeCallParameters(sdkPosition, {
        tokenId: position.positionTokenId,
        liquidityPercentage: new Percent(1, 1),
        burnToken: true,
        slippageTolerance: new Percent(config.rules.exits.REMOVE_LIQUIDITY_SLIPPAGE_BPS, 10_000),
        deadline,
      });
      return { to: positionManagerAddress, data: calldata as `0x${string}`, value: BigInt(value) };
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
    verifyOnChain: async (confirmedTxHash) => {
      const live = await livePositionState.getLiveState(position);
      if (live.liquidity !== 0n) {
        return { ok: false, reason: `expected liquidity 0 after burn, still reads ${live.liquidity}` };
      }
      // VALIDATION PHASE: realized proceeds from THIS transaction's own
      // confirmed receipt. The burn is already proven by the liquidity read
      // above, so a failed proceeds read is returned as `resumable: true`:
      // the pipeline keeps the attempt at CONFIRMED (never FAILED), so the
      // exit is never reverted to ACTIVE over a burned LP, and the next tick
      // re-runs only this verification against the same hash -- nothing is
      // rebuilt or re-broadcast. (P1 fix: this used to return a plain
      // `ok: false`, which the pipeline treats as a definitive failure.)
      // H1: the TOKEN side is read from the SAME receipt with the SAME
      // decoder (the injected reader is token-agnostic -- it takes the ERC20
      // address), so a USDG-only burn is PROVEN (0 TOKEN transferred to the
      // wallet in this exact transaction), never inferred from a live
      // wallet balance that unrelated activity could move. Same resumable
      // treatment as the USDG read on failure.
      let usdgProceedsRaw: bigint;
      let tokenProceedsRaw: bigint;
      try {
        usdgProceedsRaw = await readUsdgTransfersTo(confirmedTxHash, usdgAddress, wallet);
        tokenProceedsRaw = await readUsdgTransfersTo(confirmedTxHash, position.tokenAddress, wallet);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, resumable: true, reason: `burn verified but proceeds could not be measured: ${message}` };
      }
      return { ok: true, data: { liquidityZero: true, usdgProceedsRaw, tokenProceedsRaw } };
    },
  };
}

import { getAddress } from 'viem';
import { Percent, Token } from '@uniswap/sdk-core';
import { v4Sdk } from '../blockchain/uniswapSdk';
import { config } from '../config';
import type { TxSafetyDeps } from '../execution/types';
import * as txSteps from '../execution/viemTxSteps';
import type { PositionRecord } from '../positions/types';
import type { LivePositionStateProvider, PoolPriceProvider } from '../monitoring/types';

const DEADLINE_WINDOW_SECONDS = 10 * 60; // 10 minutes from build time -- generous enough to survive the SIMULATED/GAS_CHECKED/SIGNED steps, short enough that a very stale resumed attempt fails loudly instead of executing against a long-gone price

/** Same construction pattern as `monitoring/computePositionMetrics.ts` -- real `Token` entities (not placeholders), since the v4 SDK's `Position`/`Pool` classes call real methods on them (`.isNative`, `.equals()`, etc.), not just read `.address`. */
function buildV4Position(position: PositionRecord, liquidity: bigint, sqrtPriceX96: bigint, tickCurrent: number) {
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
 * `slippageTolerance` is set to 100% (no minimum) for
 * `amount0Min`/`amount1Min` -- consistent with the "no minimum-received
 * protection anywhere in the exit flow" intent, though the spec's OFF
 * instruction technically named only the swap leg (flagged as a judgment
 * call in the module plan).
 *
 * `verifyOnChain` re-reads live position state and confirms liquidity is
 * genuinely 0 -- proving the burn actually happened on-chain, not just
 * that the transaction didn't revert.
 */
export function buildRemoveLiquidityDeps(
  position: PositionRecord,
  livePositionState: LivePositionStateProvider,
  poolPrice: PoolPriceProvider,
): TxSafetyDeps<{ liquidityZero: true }> {
  const positionManagerAddress = config.uniswap.v4.positionManager as `0x${string}`;

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
        slippageTolerance: new Percent(1, 1),
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
    verifyOnChain: async () => {
      const live = await livePositionState.getLiveState(position);
      if (live.liquidity !== 0n) {
        return { ok: false, reason: `expected liquidity 0 after burn, still reads ${live.liquidity}` };
      }
      return { ok: true, data: { liquidityZero: true } };
    },
  };
}

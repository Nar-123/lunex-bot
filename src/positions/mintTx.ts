import { getAddress } from 'viem';
import type { Address } from 'viem';
import { Percent, Token } from '@uniswap/sdk-core';
import { v4Sdk } from '../blockchain/uniswapSdk';
import { discoverMintedTokenId } from '../blockchain/erc721';
import { getExecutorAddress } from '../blockchain/walletClient';
import { config } from '../config';
import type { TxSafetyDeps } from '../execution/types';
import * as txSteps from '../execution/viemTxSteps';
import type { LivePositionStateProvider } from '../monitoring/types';
import type { PositionPoolContext, PositionRecord } from './types';
import { ensurePositionManagerBinding } from './positionManagerBinding';

const DEADLINE_WINDOW_SECONDS = 10 * 60; // same generous-but-bounded window as exits/removeLiquidityTx.ts

export interface MintInput {
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  pool: PositionPoolContext;
  tickLower: number;
  tickUpper: number;
  entryUsdgRaw: bigint;
}

export interface MintVerifyData {
  positionTokenId: string;
  liquidity: bigint;
}

export interface BuildMintDepsOptions {
  /** Injectable for tests -- defaults to the real configured executor wallet (also the mint's `recipient`). */
  walletAddress?: Address;
  /** Injectable for tests -- defaults to the real on-chain Transfer-log lookup. */
  discoverTokenId?: (txHash: `0x${string}`, contractAddress: Address, recipient: Address) => Promise<bigint>;
  /** Injectable for tests -- defaults to the real `PositionManager.poolManager()` binding self-check (see `positionManagerBinding.ts`). */
  ensureBinding?: () => Promise<void>;
}

/** Same construction pattern as `exits/removeLiquidityTx.ts`'s `buildV4Position` -- real `Token` entities, not placeholders, since the v4 SDK calls real methods on them. Uses `fromAmount0`/`fromAmount1` (single-sided) rather than a known liquidity value, since a NEW position's liquidity is exactly what needs deriving from the decided USDG deposit amount. */
function buildMintV4Position(input: MintInput, sqrtPriceX96: bigint, tickCurrent: number) {
  const usdgAddress = getAddress(config.quoteAsset.ADDRESS);
  const currency0Address = getAddress(input.pool.currency0);
  const currency1Address = getAddress(input.pool.currency1);
  const usdgIsCurrency0 = currency0Address === usdgAddress;

  const usdgToken = new Token(config.chain.chainId, usdgIsCurrency0 ? currency0Address : currency1Address, config.quoteAsset.DECIMALS, 'USDG');
  const otherToken = new Token(config.chain.chainId, usdgIsCurrency0 ? currency1Address : currency0Address, input.tokenDecimals, input.tokenSymbol);
  const currency0Token = usdgIsCurrency0 ? usdgToken : otherToken;
  const currency1Token = usdgIsCurrency0 ? otherToken : usdgToken;

  const pool = new v4Sdk.Pool(
    currency0Token,
    currency1Token,
    input.pool.fee,
    input.pool.tickSpacing,
    input.pool.hooks,
    sqrtPriceX96.toString(),
    '0',
    tickCurrent,
  );

  return usdgIsCurrency0
    ? v4Sdk.Position.fromAmount0({ pool, tickLower: input.tickLower, tickUpper: input.tickUpper, amount0: input.entryUsdgRaw.toString(), useFullPrecision: true })
    : v4Sdk.Position.fromAmount1({ pool, tickLower: input.tickLower, tickUpper: input.tickUpper, amount1: input.entryUsdgRaw.toString() });
}

/**
 * The open-position flow's mint leg -- a SINGLE `executeCriticalTransaction`
 * call, unlike `exits/`'s two-transaction flow, because a USDG-only
 * one-sided deposit needs no swap up front: the decided position size is
 * already USDG, deposited directly into the pre-computed range.
 *
 * Uses `@uniswap/v4-sdk`'s `V4PositionManager.addCallParameters` --
 * verified by reading the SDK source directly (same discipline as
 * `exits/removeLiquidityTx.ts`'s `removeCallParameters` verification, not
 * assumed from memory): presence of a `recipient` key (not `tokenId`) is
 * what `isMint()` uses to select the MINT_POSITION action internally, and
 * `createPool`/`sqrtPriceX96` are correctly omitted -- `pools/selectPool.ts`
 * only ever returns pools that already exist and are already initialized,
 * so this mint never needs to initialize one itself.
 *
 * `hookData` is omitted (falls through to the SDK's own `EMPTY_BYTES`
 * default) -- no pool selected so far has been observed to need
 * hook-specific mint calldata; flagged here as a real gap if that ever
 * changes; the SDK's own `addMint` default is what's supplying the actual
 * empty value at that point.
 *
 * `slippageTolerance` is 100% (no minimum `amount0Min`/`amount1Min`),
 * consistent with the same "no minimum-received protection anywhere in
 * this codebase's exit/open flows" judgment call already made for
 * `removeCallParameters` -- the SIMULATED checkpoint (an `eth_call`)
 * catches an outright-broken mint before broadcast either way.
 *
 * `verifyOnChain` receives the mint's own confirmed transaction hash
 * (added to `TxSafetyDeps` specifically for this -- see
 * `execution/types.ts`'s doc comment) and decodes the ERC721
 * `Transfer(0x0 -> recipient)` log to discover the tokenId the
 * PositionManager itself assigned -- there is no other way to learn it.
 * Only once that tokenId's live liquidity reads > 0 is the mint considered
 * verified; `positions/openPosition.ts` never marks a position ACTIVE
 * before this returns `ok: true`.
 */
export function buildMintDeps(
  input: MintInput,
  livePositionState: LivePositionStateProvider,
  poolPrice: { getPriceState: (pool: PositionPoolContext) => Promise<{ sqrtPriceX96: bigint; tickCurrent: number }> },
  options: BuildMintDepsOptions = {},
): TxSafetyDeps<MintVerifyData> {
  const positionManagerAddress = config.uniswap.v4.positionManager as Address;
  const wallet = options.walletAddress ?? getExecutorAddress();
  const discoverTokenId = options.discoverTokenId ?? discoverMintedTokenId;
  const ensureBinding = options.ensureBinding ?? ensurePositionManagerBinding;

  return {
    buildTransaction: async () => {
      await ensureBinding();
      const price = await poolPrice.getPriceState(input.pool);
      const sdkPosition = buildMintV4Position(input, price.sqrtPriceX96, price.tickCurrent);
      const deadline = Math.floor(Date.now() / 1000) + DEADLINE_WINDOW_SECONDS;
      const { calldata, value } = v4Sdk.V4PositionManager.addCallParameters(sdkPosition, {
        recipient: wallet,
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
    verifyOnChain: async (confirmedTxHash) => {
      let tokenId: bigint;
      try {
        tokenId = await discoverTokenId(confirmedTxHash, positionManagerAddress, wallet);
      } catch (err) {
        return { ok: false, reason: `could not discover minted tokenId: ${err instanceof Error ? err.message : String(err)}` };
      }
      const positionTokenId = tokenId.toString();

      // A throwaway PositionRecord shape -- only pool/tickLower/tickUpper/positionTokenId matter to LivePositionStateProvider's real implementation (see monitoring/positionStateReader.ts), the rest is irrelevant to this read.
      const probe: PositionRecord = {
        id: '',
        tokenAddress: input.tokenAddress,
        tokenSymbol: input.tokenSymbol,
        tokenDecimals: input.tokenDecimals,
        pool: input.pool,
        tickLower: input.tickLower,
        tickUpper: input.tickUpper,
        positionTokenId,
        entryUsdgRaw: input.entryUsdgRaw,
        entrySqrtPriceX96: 0n,
        entryTick: 0,
        status: 'OPENING',
        openIdempotencyKey: '',
        closeIdempotencyKey: null,
        openedAt: null,
        closedAt: null,
        closeReason: null,
      };
      const live = await livePositionState.getLiveState(probe);
      if (live.liquidity <= 0n) {
        return { ok: false, reason: `minted position ${positionTokenId} reads liquidity ${live.liquidity} (expected > 0)` };
      }
      return { ok: true, data: { positionTokenId, liquidity: live.liquidity } };
    },
  };
}

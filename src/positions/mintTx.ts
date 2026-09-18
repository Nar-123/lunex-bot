import { getAddress } from 'viem';
import type { Address } from 'viem';
import { Percent, Token } from '@uniswap/sdk-core';
import { v4Sdk } from '../blockchain/uniswapSdk';
import { discoverMintedTokenId, MintedTokenIdNotFoundError } from '../blockchain/erc721';
import { getExecutorAddress } from '../blockchain/walletClient';
import { getPublicClient } from '../blockchain/viemClient';
import { V4_POSITION_MANAGER_ABI } from '../blockchain/abis/v4PositionManager';
import { config } from '../config';
import type { TxSafetyDeps } from '../execution/types';
import * as txSteps from '../execution/viemTxSteps';
import type { LivePositionStateProvider } from '../monitoring/types';
import type { PositionPoolContext, PositionRecord } from './types';
import { ensurePositionManagerBinding } from './positionManagerBinding';

const DEADLINE_WINDOW_SECONDS = 10 * 60; // same generous-but-bounded window as exits/removeLiquidityTx.ts

/**
 * P0-4 fix: `screeningCycle.ts` computes `tickLower`/`tickUpper` from a
 * price snapshot read at SCREENING time (T1, persisted as
 * `Position.entryTick`/`entrySqrtPriceX96`) via `computeLpRange.ts`
 * (audited, unchanged by this fix). `buildMintV4Position` below reads a
 * FRESH pool price at MINT-BUILD time (T2, potentially much later --
 * a stuck/retried OPENING position can sit for a while). Between T1 and
 * T2, price can move enough that the T1-computed range is no longer a
 * valid ONE-SIDED USDG entry against the T2 price.
 *
 * `computeLpRange.ts`'s own invariant (traced from its source, not
 * guessed): for a Case B range (USDG=currency0), `tickLower` is computed
 * STRICTLY ABOVE the T1 `tickCurrent`; for a Case A range
 * (USDG=currency1), `tickUpper` is computed STRICTLY BELOW it. That
 * invariant is what makes `entryUsdgRaw` mint as PURE USDG via
 * `fromAmount0`/`fromAmount1` -- it only continues to hold if the CURRENT
 * price is still on the correct side of the range. If price has since
 * moved into or past the range, minting into it would silently produce a
 * mixed/two-sided position instead of the intended single-sided entry.
 *
 * Returns `{ ok: false }` (never throws itself -- the caller decides how
 * to surface it) when the fresh price is no longer compatible.
 */
export function validateMintPriceFreshness(input: {
  freshTickCurrent: number;
  tickLower: number;
  tickUpper: number;
  usdgIsCurrency0: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const { freshTickCurrent, tickLower, tickUpper, usdgIsCurrency0 } = input;
  if (usdgIsCurrency0) {
    // Case B: one-sided-USDG range sits AT/ABOVE the T1 tickCurrent -- still a valid pure-USDG entry only while the fresh price stays BELOW tickLower.
    if (freshTickCurrent >= tickLower) {
      return {
        ok: false,
        reason: `entry range is stale: price moved into/past the one-sided range since screening (fresh tick ${freshTickCurrent} >= tickLower ${tickLower})`,
      };
    }
  } else {
    // Case A: one-sided-USDG range sits AT/BELOW the T1 tickCurrent -- still a valid pure-USDG entry only while the fresh price stays AT/ABOVE tickUpper.
    if (freshTickCurrent < tickUpper) {
      return {
        ok: false,
        reason: `entry range is stale: price moved into/past the one-sided range since screening (fresh tick ${freshTickCurrent} < tickUpper ${tickUpper})`,
      };
    }
  }
  return { ok: true };
}

/**
 * P1-9 fix: cross-checks the minted tokenId's REAL on-chain `PoolKey`
 * (read via `PositionManager.getPoolAndPositionInfo`, see
 * `blockchain/abis/v4PositionManager.ts`'s doc comment) against the pool
 * this mint was supposed to have used (`input.pool`, the SAME object
 * `buildTransaction` built the mint calldata from). Before this, the only
 * on-chain identity check `verifyOnChain` performed was "some ERC721
 * Transfer(0x0->wallet) event exists in this receipt for the configured
 * PositionManager" plus "liquidity > 0 at the (poolId, tickLower,
 * tickUpper, salt=tokenId) key WE SUPPLY" -- i.e. ownership plus a
 * liquidity read keyed by values taken on faith from `input`, never
 * independently confirmed against the chain. This closes that gap for
 * everything ABI-decodable (currency0/currency1/fee/tickSpacing/hooks --
 * a plain tuple, not packed). `tickLower`/`tickUpper` are NOT compared
 * here: they live inside `getPoolAndPositionInfo`'s packed `info` return
 * value (Uniswap v4's `PositionInfo`/`PositionInfoLibrary` bit layout),
 * which this codebase does not decode anywhere -- see that ABI file's doc
 * comment for why (no verified source for the exact bit layout was
 * available in this environment, and guessing it wrong would be worse
 * than not checking). Exported for direct unit testing without an RPC call.
 */
export function checkMintedPoolIdentity(
  onChainPoolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address },
  expectedPool: PositionPoolContext,
): { ok: true } | { ok: false; reason: string } {
  if (getAddress(onChainPoolKey.currency0) !== getAddress(expectedPool.currency0) || getAddress(onChainPoolKey.currency1) !== getAddress(expectedPool.currency1)) {
    return {
      ok: false,
      reason: `minted position's on-chain pool currencies (${onChainPoolKey.currency0}/${onChainPoolKey.currency1}) do not match the expected pool (${expectedPool.currency0}/${expectedPool.currency1})`,
    };
  }
  if (onChainPoolKey.fee !== expectedPool.fee) {
    return { ok: false, reason: `minted position's on-chain pool fee (${onChainPoolKey.fee}) does not match the expected pool fee (${expectedPool.fee})` };
  }
  if (onChainPoolKey.tickSpacing !== expectedPool.tickSpacing) {
    return {
      ok: false,
      reason: `minted position's on-chain pool tickSpacing (${onChainPoolKey.tickSpacing}) does not match the expected pool tickSpacing (${expectedPool.tickSpacing})`,
    };
  }
  if (getAddress(onChainPoolKey.hooks) !== getAddress(expectedPool.hooks)) {
    return { ok: false, reason: `minted position's on-chain pool hooks (${onChainPoolKey.hooks}) do not match the expected pool hooks (${expectedPool.hooks})` };
  }
  return { ok: true };
}

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
  /** Injectable for tests (P1-9) -- defaults to the real `PositionManager.getPoolAndPositionInfo(tokenId)` on-chain read. */
  getPoolAndPositionInfo?: (tokenId: bigint) => Promise<{ currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }>;
}

/**
 * Same construction pattern as `exits/removeLiquidityTx.ts`'s `buildV4Position` -- real `Token` entities, not placeholders, since the v4 SDK calls real methods on them. Uses `fromAmount0`/`fromAmount1` (single-sided) rather than a known liquidity value, since a NEW position's liquidity is exactly what needs deriving from the decided USDG deposit amount.
 *
 * Exported (Phase 12G) purely so `tests/positions/mintTx.test.ts` can assert
 * the constructed USDG `Token`'s `.decimals` directly matches
 * `config.quoteAsset.DECIMALS` -- not a new abstraction, the function
 * already existed, only its visibility changed.
 */
export function buildMintV4Position(input: MintInput, sqrtPriceX96: bigint, tickCurrent: number) {
  const usdgAddress = getAddress(config.quoteAsset.ADDRESS);
  const currency0Address = getAddress(input.pool.currency0);
  const currency1Address = getAddress(input.pool.currency1);
  const usdgIsCurrency0 = currency0Address === usdgAddress;

  // P0-4 fix: validate the FRESH price (tickCurrent, just read this call)
  // is still compatible with the one-sided range decided at screening
  // time (input.tickLower/tickUpper) BEFORE constructing anything from it.
  // Thrown, not returned -- buildTransaction's caller
  // (executeCriticalTransaction) already treats any throw here as
  // ambiguous/resumable (see that file's outer catch), so this safely
  // aborts THIS attempt without marking anything FAILED; the position
  // stays OPENING and is retried (with a fresh price read) on a later
  // tick, per the explicit "abort safely... DO NOT mint using stale
  // range" requirement.
  const freshnessCheck = validateMintPriceFreshness({ freshTickCurrent: tickCurrent, tickLower: input.tickLower, tickUpper: input.tickUpper, usdgIsCurrency0 });
  if (!freshnessCheck.ok) {
    throw new Error(freshnessCheck.reason);
  }

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
 * `slippageTolerance` is `config.rules.lpStrategy.MINT_SLIPPAGE_BPS` (P1-10
 * fix -- was 100%/no protection at all; see that constant's doc comment
 * for why 100 bps, not an invented number). The SIMULATED checkpoint (an
 * `eth_call`) still catches an outright-broken mint before broadcast, but
 * a bounded `amount0Min`/`amount1Min` additionally protects against a mint
 * that would otherwise succeed at an unfavorable price after movement
 * between build and mine.
 *
 * `verifyOnChain` receives the mint's own confirmed transaction hash
 * (added to `TxSafetyDeps` specifically for this -- see
 * `execution/types.ts`'s doc comment) and decodes the ERC721
 * `Transfer(0x0 -> recipient)` log to discover the tokenId the
 * PositionManager itself assigned -- there is no other way to learn it.
 * P1-9 fix: that tokenId's on-chain `PoolKey` (via
 * `getPoolAndPositionInfo`) is then cross-checked against `input.pool`
 * (see `checkMintedPoolIdentity`) -- before this, identity rested on
 * ownership (the Transfer event) and a liquidity read keyed by values
 * taken on faith from `input`, never independently confirmed. Only once
 * that identity check passes AND that tokenId's live liquidity reads > 0
 * is the mint considered verified; `positions/openPosition.ts` never marks
 * a position ACTIVE before this returns `ok: true`.
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
  const getPoolAndPositionInfo =
    options.getPoolAndPositionInfo ??
    ((tokenId: bigint) =>
      getPublicClient().readContract({
        address: positionManagerAddress,
        abi: V4_POSITION_MANAGER_ABI,
        functionName: 'getPoolAndPositionInfo',
        args: [tokenId],
      }).then(([poolKey]) => poolKey));

  return {
    buildTransaction: async () => {
      await ensureBinding();
      const price = await poolPrice.getPriceState(input.pool);
      const sdkPosition = buildMintV4Position(input, price.sqrtPriceX96, price.tickCurrent);
      const deadline = Math.floor(Date.now() / 1000) + DEADLINE_WINDOW_SECONDS;
      const { calldata, value } = v4Sdk.V4PositionManager.addCallParameters(sdkPosition, {
        recipient: wallet,
        slippageTolerance: new Percent(config.rules.lpStrategy.MINT_SLIPPAGE_BPS, 10_000),
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
        // C2 fix: this runs AFTER waitForReceipt already confirmed the mint
        // mined successfully -- by construction, funds may already be
        // on-chain. Only a `MintedTokenIdNotFoundError` is a DEFINITIVE
        // fact (the mint's own confirmed receipt genuinely has no
        // Transfer(0x0->recipient) log for our contract -- the mint
        // provably did not mint anything). Every other error (RPC
        // timeout/429/500/connection reset/CALL_EXCEPTION/stale read/etc.)
        // is a transport failure, NOT proof the mint failed -- it must
        // propagate so executeCriticalTransaction's outer catch treats it
        // as ambiguous/resumable, never VERIFICATION_FAILED. Converting a
        // transient RPC error into a definitive failure here would make
        // openPosition.ts call markFailed + release capital for a mint
        // that actually succeeded and is sitting unmonitored on-chain.
        if (err instanceof MintedTokenIdNotFoundError) {
          return { ok: false, reason: `could not discover minted tokenId: ${err.message}` };
        }
        throw err;
      }
      const positionTokenId = tokenId.toString();

      // P1-9 fix: an RPC failure here is a transport failure, same
      // reasoning as discoverTokenId's catch above -- it must propagate as
      // ambiguous/resumable, never be treated as "identity confirmed
      // mismatched." Only a SUCCESSFUL read that disagrees with `input.pool`
      // is a definitive verification failure.
      const onChainPoolKey = await getPoolAndPositionInfo(tokenId);
      const identityCheck = checkMintedPoolIdentity(onChainPoolKey, input.pool);
      if (!identityCheck.ok) {
        return { ok: false, reason: `minted tokenId ${positionTokenId}: ${identityCheck.reason}` };
      }

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
        realizedUsdgRaw: null,
      };
      const live = await livePositionState.getLiveState(probe);
      if (live.liquidity <= 0n) {
        return { ok: false, reason: `minted position ${positionTokenId} reads liquidity ${live.liquidity} (expected > 0)` };
      }
      return { ok: true, data: { positionTokenId, liquidity: live.liquidity } };
    },
  };
}

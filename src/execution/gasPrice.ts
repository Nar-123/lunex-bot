/**
 * Legacy gasPrice strategy with bounded base-fee headroom.
 *
 * Chain fee behaviour (VERIFIED on Robinhood Chain, chainId 4663 -- an
 * Arbitrum-Orbit chain, first live entry, 2026-09-19):
 *  - the executor signs LEGACY transactions (`type: 'legacy'`, see
 *    `viemTxSteps.signTxWithAccount`); that transaction type is kept;
 *  - `eth_gasPrice` returns exactly the CURRENT block base fee -- zero
 *    headroom -- while the base fee moves every block (~10 blocks/s), in the
 *    observed window between ~66.6M and ~69.2M wei;
 *  - the node rejects a legacy tx whose gasPrice is below the base fee at
 *    submission time: JSON-RPC -32000 "max fee per gas less than block base
 *    fee" (not accepted, nothing mined);
 *  - the fee actually CHARGED is the inclusion block's base fee
 *    (`effectiveGasPrice` < signed `gasPrice` on both live txs: 66,982,000 vs
 *    67,752,000 and 66,724,000 vs 67,128,000), so headroom above the base fee
 *    is a ceiling, not a payment.
 *
 * Strategy: `gasPrice = min(cap, ceil(reference x (1 + headroom)))` where
 * `reference = max(eth_gasPrice, latest baseFeePerGas)`. Bounded on BOTH
 * sides: never above `maxGasPriceWei`, and never signed at all if the cap
 * leaves less than `minHeadroomBps` over the reference (a tx that would
 * almost certainly be rejected, or one whose network price is above what the
 * operator allows) -- that condition throws `GasPriceAboveCapError`, which
 * the executor's GAS_CHECK treats as transient (retried next tick, never
 * FAILED, no nonce assigned, nothing signed).
 */

const BPS = 10_000n;

export interface GasPricePolicy {
  /** Target headroom over the reference price, in basis points (2000 = +20%). */
  headroomBps: number;
  /** Minimum acceptable headroom after the cap is applied; below this, refuse to sign. */
  minHeadroomBps: number;
  /** Absolute ceiling for the signed gasPrice, in wei. */
  maxGasPriceWei: bigint;
}

export interface GasPriceInputs {
  /** `eth_gasPrice` */
  networkGasPrice: bigint;
  /** `baseFeePerGas` of the latest block; null on a non-EIP-1559 chain. */
  baseFeePerGas: bigint | null;
}

export interface GasPriceDecision {
  gasPrice: bigint;
  /** max(networkGasPrice, baseFeePerGas) -- what the headroom is applied to. */
  referencePrice: bigint;
  /** Headroom actually obtained over the reference, in basis points (floored). */
  effectiveHeadroomBps: bigint;
  /** True when the cap, not the target headroom, determined the price. */
  capped: boolean;
}

export class GasPriceAboveCapError extends Error {
  constructor(readonly referencePrice: bigint, readonly maxGasPriceWei: bigint, readonly minHeadroomBps: number) {
    super(
      `network gas price ${referencePrice} wei leaves less than ${minHeadroomBps} bps headroom under the configured cap ` +
        `${maxGasPriceWei} wei -- not signing this tick (retried later, nothing assigned or broadcast)`,
    );
    this.name = 'GasPriceAboveCapError';
  }
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export function validateGasPricePolicy(p: GasPricePolicy): void {
  if (!Number.isInteger(p.headroomBps) || !Number.isInteger(p.minHeadroomBps)) throw new Error('gas price headroom must be integer basis points');
  if (p.minHeadroomBps < 0 || p.headroomBps < p.minHeadroomBps) throw new Error('gas price policy requires 0 <= minHeadroomBps <= headroomBps');
  if (p.headroomBps > 10_000) throw new Error('gas price headroom above 100% is not allowed');
  if (p.maxGasPriceWei <= 0n) throw new Error('maxGasPriceWei must be positive');
}

/** Pure: the legacy gasPrice to sign. Throws `GasPriceAboveCapError` if the bounded policy cannot provide enough headroom. */
export function computeLegacyGasPrice(inputs: GasPriceInputs, policy: GasPricePolicy): GasPriceDecision {
  validateGasPricePolicy(policy);
  const base = inputs.baseFeePerGas ?? 0n;
  const referencePrice = inputs.networkGasPrice > base ? inputs.networkGasPrice : base;
  if (referencePrice <= 0n) throw new Error(`refusing to price a transaction from a non-positive reference gas price (${referencePrice})`);

  const target = ceilDiv(referencePrice * (BPS + BigInt(policy.headroomBps)), BPS);
  const minimum = ceilDiv(referencePrice * (BPS + BigInt(policy.minHeadroomBps)), BPS);
  const capped = target > policy.maxGasPriceWei;
  const gasPrice = capped ? policy.maxGasPriceWei : target;
  if (gasPrice < minimum) throw new GasPriceAboveCapError(referencePrice, policy.maxGasPriceWei, policy.minHeadroomBps);

  return { gasPrice, referencePrice, effectiveHeadroomBps: ((gasPrice - referencePrice) * BPS) / referencePrice, capped };
}

/** Pure: would a legacy tx signed at `signedGasPrice` still be accepted against `currentBaseFee`? (Node rule: gasPrice >= baseFee.) */
export function coversBaseFee(signedGasPrice: bigint, currentBaseFee: bigint): boolean {
  return signedGasPrice >= currentBaseFee;
}

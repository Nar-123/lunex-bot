import { describe, expect, it } from 'vitest';
import { computeLegacyGasPrice, coversBaseFee, GasPriceAboveCapError, validateGasPricePolicy, type GasPricePolicy } from '../../src/execution/gasPrice';
import { config } from '../../src/config';

// Real values from the first live entry (Robinhood Chain, 2026-09-19).
const LIVE_BASE_FEE = 67_172_000n; // eth_gasPrice == baseFee exactly on this chain
const POLICY: GasPricePolicy = { headroomBps: 2000, minHeadroomBps: 500, maxGasPriceWei: 1_000_000_000n };

describe('computeLegacyGasPrice -- bounded base-fee headroom', () => {
  it('normal base fee: +20% over max(eth_gasPrice, baseFee)', () => {
    const d = computeLegacyGasPrice({ networkGasPrice: LIVE_BASE_FEE, baseFeePerGas: LIVE_BASE_FEE }, POLICY);
    expect(d.gasPrice).toBe(80_606_400n); // 67,172,000 x 1.2
    expect(d.referencePrice).toBe(LIVE_BASE_FEE);
    expect(d.effectiveHeadroomBps).toBe(2000n);
    expect(d.capped).toBe(false);
  });

  it('uses the HIGHER of eth_gasPrice and the latest base fee as the reference', () => {
    expect(computeLegacyGasPrice({ networkGasPrice: 100n, baseFeePerGas: 1000n }, POLICY).referencePrice).toBe(1000n);
    expect(computeLegacyGasPrice({ networkGasPrice: 1000n, baseFeePerGas: 100n }, POLICY).referencePrice).toBe(1000n);
    expect(computeLegacyGasPrice({ networkGasPrice: 1000n, baseFeePerGas: null }, POLICY).referencePrice).toBe(1000n); // non-1559 chain
  });

  it('rapid base fee increase: the live window (66.6M..69.2M wei) stays covered by a price signed at its LOW end', () => {
    const signed = computeLegacyGasPrice({ networkGasPrice: 66_618_000n, baseFeePerGas: 66_618_000n }, POLICY).gasPrice;
    for (const laterBaseFee of [66_618_000n, 67_752_000n, 68_836_000n, 69_220_000n]) expect(coversBaseFee(signed, laterBaseFee)).toBe(true);
    // the OLD strategy (zero headroom) is exactly what failed live:
    expect(coversBaseFee(67_752_000n /* live approve gasPrice */, 68_088_000n /* base fee at 18:41:38 */)).toBe(false);
  });

  it('a rise beyond the headroom is NOT covered (-> node rejects, handled as BROADCAST_REJECTED_FEE_TOO_LOW)', () => {
    const signed = computeLegacyGasPrice({ networkGasPrice: 1000n, baseFeePerGas: 1000n }, POLICY).gasPrice; // 1200
    expect(coversBaseFee(signed, 1201n)).toBe(false);
  });

  it('gasPrice below the current base fee is rejected; equal is accepted (node rule gasPrice >= baseFee)', () => {
    expect(coversBaseFee(66_172_000n, 67_172_000n)).toBe(false);
    expect(coversBaseFee(67_172_000n, 67_172_000n)).toBe(true);
    expect(coversBaseFee(67_172_001n, 67_172_000n)).toBe(true);
  });

  it('fee rounding: always rounds UP (never a wei below the target headroom)', () => {
    // 7 x 1.2 = 8.4 -> 9 ; 1 x 1.2 = 1.2 -> 2
    expect(computeLegacyGasPrice({ networkGasPrice: 7n, baseFeePerGas: 7n }, POLICY).gasPrice).toBe(9n);
    expect(computeLegacyGasPrice({ networkGasPrice: 1n, baseFeePerGas: 1n }, POLICY).gasPrice).toBe(2n);
    // exact multiple: no spurious +1
    expect(computeLegacyGasPrice({ networkGasPrice: 10n, baseFeePerGas: 10n }, POLICY).gasPrice).toBe(12n);
  });

  it('maximum fee cap: never signs above maxGasPriceWei; clamps when enough headroom remains', () => {
    const d = computeLegacyGasPrice({ networkGasPrice: 900_000_000n, baseFeePerGas: 900_000_000n }, POLICY); // target 1.08 gwei > cap
    expect(d.gasPrice).toBe(1_000_000_000n);
    expect(d.capped).toBe(true);
    expect(d.effectiveHeadroomBps).toBe(1111n); // 11.1% >= 5% minimum
  });

  it('insufficient fee headroom under the cap -> GasPriceAboveCapError (nothing signed)', () => {
    expect(() => computeLegacyGasPrice({ networkGasPrice: 960_000_000n, baseFeePerGas: 960_000_000n }, POLICY)).toThrow(GasPriceAboveCapError); // cap leaves only 4.2%
    expect(() => computeLegacyGasPrice({ networkGasPrice: 2_000_000_000n, baseFeePerGas: null }, POLICY)).toThrow(GasPriceAboveCapError); // network above the cap
  });

  it('exact minimum-headroom boundary under the cap is accepted', () => {
    // reference 952,380,953: 5% -> ceil(999,999,000.65) = 1,000,000,001 > cap -> refused ; reference 952,380,952 -> exactly 999,999,999.6 -> 1,000,000,000 == cap -> accepted
    expect(computeLegacyGasPrice({ networkGasPrice: 952_380_952n, baseFeePerGas: null }, POLICY).gasPrice).toBe(1_000_000_000n);
    expect(() => computeLegacyGasPrice({ networkGasPrice: 952_380_953n, baseFeePerGas: null }, POLICY)).toThrow(GasPriceAboveCapError);
  });

  it('non-positive reference price is refused', () => {
    expect(() => computeLegacyGasPrice({ networkGasPrice: 0n, baseFeePerGas: 0n }, POLICY)).toThrow(/non-positive/);
  });

  it('policy is validated: bounded headroom, min <= target, positive cap', () => {
    expect(() => validateGasPricePolicy({ ...POLICY, headroomBps: 10_001 })).toThrow();
    expect(() => validateGasPricePolicy({ ...POLICY, minHeadroomBps: 3000 })).toThrow();
    expect(() => validateGasPricePolicy({ ...POLICY, minHeadroomBps: -1 })).toThrow();
    expect(() => validateGasPricePolicy({ ...POLICY, maxGasPriceWei: 0n })).toThrow();
    expect(() => validateGasPricePolicy({ ...POLICY, headroomBps: 20.5 })).toThrow();
  });

  it('the shipped configuration is a valid, bounded policy', () => {
    const ex = config.rules.execution;
    expect(() => validateGasPricePolicy({ headroomBps: ex.GAS_PRICE_HEADROOM_BPS, minHeadroomBps: ex.GAS_PRICE_MIN_HEADROOM_BPS, maxGasPriceWei: ex.MAX_GAS_PRICE_WEI })).not.toThrow();
    expect(ex.MAX_GAS_PRICE_WEI).toBeGreaterThan(LIVE_BASE_FEE * 2n);
  });
});

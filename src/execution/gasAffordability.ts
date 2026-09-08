import { checkEthGasReserve } from '../capital/decideCapitalAllocation';
import { config } from '../config';
import type { StepResult } from './types';

/**
 * Pure function: is the estimated gas cost affordable given the wallet's
 * current native ETH balance? Two checks, both explicit:
 *  1. Basic affordability -- balance must cover `gasLimit * gasPrice`.
 *  2. The (currently OFF / TBD per spec) ETH gas reserve, reusing the
 *     exact same `checkEthGasReserve` toggle from `capital/` rather than
 *     a second copy of that logic -- checked against what would remain
 *     AFTER paying for this transaction, not the balance before it.
 */
export function checkGasAffordability(gasLimit: bigint, gasPrice: bigint, ethBalance: bigint): StepResult {
  if (gasLimit <= 0n || gasPrice <= 0n) {
    return { ok: false, reason: `invalid gas parameters: gasLimit=${gasLimit}, gasPrice=${gasPrice}` };
  }

  const estimatedCost = gasLimit * gasPrice;
  if (ethBalance < estimatedCost) {
    return {
      ok: false,
      reason: `insufficient ETH for gas: need ~${estimatedCost} wei, wallet has ${ethBalance} wei`,
    };
  }

  const remainingAfterTx = ethBalance - estimatedCost;
  const rules = config.rules.capital;
  return checkEthGasReserve(remainingAfterTx, rules.ETH_GAS_RESERVE_ENABLED, rules.ETH_GAS_RESERVE_MIN);
}

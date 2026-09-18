import type { Address } from 'viem';
import type { CapitalSnapshot, CapitalSnapshotProvider } from '../capital/types';
import { readUsdgBalance } from '../capital/usdgBalanceReader';
import { deriveCapitalSnapshot } from '../capital/freshCapitalSnapshot';
import type { PositionRepository } from './types';

/**
 * Real implementation of `capital/types.ts`'s `CapitalSnapshotProvider` --
 * deliberately left unbuilt in Module 5, then fixed twice more by
 * explicit review after being built (see git history / README revisions
 * 5 and 6) -- both times because intuition about which side of a ratio
 * "cancels out" turned out to be wrong, and only a concrete worked
 * example caught it.
 *
 * ## The CLOSING fix (revision 5)
 * A CLOSING position's LP hasn't actually been removed for most of the
 * exit flow, so its capital is neither "free" (not back in the wallet)
 * nor was it counted as "deployed" (an earlier version summed ACTIVE
 * only). Fixed by including CLOSING in the deployed-capital sum -- safe,
 * since that capital was never in the on-chain free-balance read either.
 *
 * ## The OPENING fix (revision 6)
 * A mirror-image gap, caught by asking "when does status become OPENING
 * relative to the tx-safety pipeline, and when does the on-chain balance
 * actually decrease?" Answer: OPENING must start BEFORE
 * `executeCriticalTransaction` even runs (so the same idempotency key
 * covers the whole flow for crash recovery), and the on-chain balance
 * only decreases once the transaction is MINED -- a blockchain fact, not
 * a design choice. So for the ENTIRE window from "Position row created"
 * through BUILT/SIMULATED/GAS_CHECKED/NONCE_ASSIGNED/SIGNED/SENT/waiting
 * for CONFIRMED, the deploying capital is *still* the wallet's on-chain
 * USDG balance. If `freeUsdgBalance` just reports that raw balance
 * unadjusted, it's WRONG in the opposite direction from the CLOSING
 * bug -- not "counted nowhere" but "counted as free when it's already
 * spoken for." Confirmed with a concrete example: three sequential
 * OPENING attempts, none yet mined, each sized against the SAME
 * un-decremented balance, together committing more USDG than the wallet
 * ever held (1050 vs. an actual 1000).
 *
 * The fix needs BOTH halves together (adding OPENING to the deployed sum
 * ALONE would double-count it, since it's also still in the raw wallet
 * balance):
 *
 *   reservedForOpening = sum(entryUsdgRaw for OPENING positions)
 *   freeUsdgBalance     = onChainBalance - reservedForOpening   (never < 0)
 *   totalDeployedUsdg   = sum(entryUsdgRaw for OPENING + ACTIVE + CLOSING)
 *
 * Algebraic proof this keeps `freeUsdgBalance + totalDeployedUsdg`
 * exactly equal to the true total portfolio value, for ANY mix of
 * statuses (not just the worked example -- OPENING_sum cancels out):
 *
 *   freeUsdgBalance + totalDeployedUsdg
 *   = (onChainBalance - OPENING_sum) + (OPENING_sum + ACTIVE_sum + CLOSING_sum)
 *   = onChainBalance + ACTIVE_sum + CLOSING_sum
 *
 * ...which is exactly the true total: `onChainBalance` already includes
 * every OPENING position's still-unspent capital (it hasn't left the
 * wallet), plus whatever's genuinely locked away in ACTIVE/CLOSING LPs.
 * See the invariant tests for the numeric confirmation, including that
 * sequential OPENING attempts before anything confirms now behave
 * identically (in total-safety terms) to fully-sequential confirmed
 * deployments -- the fix removes the timing-dependence entirely.
 *
 * ## The FAILED question (revision 7) -- no logic change needed here
 * Asked right after the above: does a position whose deploy transaction
 * DEFINITIVELY failed (never mined, so its capital never left the
 * wallet) ever get stuck double-counted -- reserved out of
 * `freeUsdgBalance` AND summed into `totalDeployedUsdg` -- forever,
 * rather than just for the OPENING window? It would have, except the
 * gap turned out to live one layer down: `PositionRepository` had no
 * method to ever move a row OUT of OPENING except `markActive` (success).
 * Fixed there, not here -- see `types.ts`'s `markFailed()` doc comment
 * for the worked example and the fix. Once a failed deploy is marked
 * `FAILED`, it is simply not in `NON_CLOSED_STATUSES` (the same bucket
 * as CLOSED), so it automatically drops out of `reservedForOpening`
 * (filtered to `status === 'OPENING'`) and `totalDeployedUsdg`
 * (`findDeployedPositions()`) with no changes needed in this file.
 */
export class PositionCapitalSnapshotProvider implements CapitalSnapshotProvider {
  constructor(
    private readonly positions: PositionRepository,
    private readonly walletAddress: Address,
    /** Injectable for tests -- defaults to the real on-chain ERC20 read. */
    private readonly readBalance: (wallet: Address) => Promise<bigint> = readUsdgBalance,
  ) {}

  async getSnapshot(): Promise<CapitalSnapshot> {
    const [onChainBalance, deployedPositions, activePositionsCount] = await Promise.all([
      this.readBalance(this.walletAddress),
      this.positions.findDeployedPositions(), // OPENING + ACTIVE + CLOSING
      this.positions.countNonClosed(),
    ]);

    // Same formula as always, now shared with createIfCapitalAllows's
    // write-time re-check (P1-1) via capital/freshCapitalSnapshot.ts.
    const { freeUsdgBalance, totalDeployedUsdg } = deriveCapitalSnapshot(onChainBalance, deployedPositions);

    return {
      freeUsdgBalance,
      activePositionsCount,
      totalDeployedUsdg,
    };
  }

  readOnChainUsdgBalance(): Promise<bigint> {
    return this.readBalance(this.walletAddress);
  }
}

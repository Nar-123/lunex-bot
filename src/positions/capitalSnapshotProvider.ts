import type { Address } from 'viem';
import type { CapitalSnapshot, CapitalSnapshotProvider } from '../capital/types';
import { readUsdgBalance } from '../capital/usdgBalanceReader';
import { deriveCapitalSnapshot, exitLegKeyPrefix } from '../capital/freshCapitalSnapshot';
import type { TransactionAttemptRepository } from '../execution/types';
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
 *
 * See the invariant tests for the numeric confirmation, including that
 * sequential OPENING attempts before anything confirms now behave
 * identically (in total-safety terms) to fully-sequential confirmed
 * deployments -- the fix removes the timing-dependence entirely.
 *
 * ## The CLOSING-after-remove fix (H2)
 * The proof above silently assumed a CLOSING position's capital is still
 * locked in its LP. It is not once its remove-liquidity has been VERIFIED:
 * the burn pays USDG back into the wallet (so it is inside
 * `onChainBalance`) while the row stays CLOSING until the TOKEN swap (if
 * any) completes -- and `CLOSING_sum` still carried the FULL entry, so that
 * USDG was counted twice (1000 wallet + 350 entry = 1350 for a true ~1000).
 * A CLOSING position whose remove-liquidity is VERIFIED now contributes only
 * what is still unconverted: 0 once fully back in USDG (the burn paid no
 * TOKEN, or its swap VERIFIED), otherwise `max(entry - receipt-measured
 * USDG the burn returned, 0)` -- the unrecovered cost basis of the TOKEN
 * awaiting its swap -- so the sum is:
 *
 *   freeUsdgBalance + totalDeployedUsdg
 *   = onChainBalance + ACTIVE_sum + CLOSING_before_remove_sum
 *                    + sum(unconverted residual for CLOSING_after_remove)
 *
 * and a leg that may be mined but is not yet verified makes the snapshot
 * unresolved (the allocator fails closed). See
 * `capital/freshCapitalSnapshot.ts` for the per-position rules.
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
    /**
     * H2: needed to account for USDG a CLOSING position has already
     * returned to the wallet. Optional only so snapshot-only tests with no
     * CLOSING rows need not construct one; when absent and a CLOSING row
     * exists, the snapshot is marked unresolved (the allocator refuses it)
     * rather than silently double-counting. Production wiring
     * (`composition/deps.ts`) always passes it.
     */
    private readonly txAttempts?: TransactionAttemptRepository,
  ) {}

  /**
   * H2 read ORDER is deliberate (sequential, not Promise.all):
   *  1. position rows, THEN 2. the on-chain balance -- an OPENING row whose
   *     mint lands in between is still seen as OPENING, so its capital is
   *     subtracted even though the balance already dropped (conservative
   *     under-count), never the reverse;
   *  2. the balance, THEN 3. CLOSING rows' exit-leg attempts -- an exit
   *     transaction can only reach the chain after its attempt is persisted
   *     at SIGNED, so if its USDG is already in the balance read, the later
   *     attempt read sees it at SIGNED..VERIFIED: either unresolved (fail
   *     closed) or VERIFIED with a measured amount that is then removed
   *     from the deployed figure. A leg verified AFTER the balance read only
   *     makes the snapshot conservative (returned USDG subtracted from
   *     deployed but not yet seen in the balance).
   * `createIfCapitalAllows` re-derives the same way under CapitalLock
   * before anything is written, so this per-cycle sizing read is never
   * the last word.
   */
  async getSnapshot(): Promise<CapitalSnapshot> {
    const deployedPositions = await this.positions.findDeployedPositions(); // OPENING + ACTIVE + CLOSING
    const onChainBalance = await this.readBalance(this.walletAddress);
    const closeKeys = deployedPositions.filter((p) => p.status === 'CLOSING' && p.closeIdempotencyKey).map((p) => exitLegKeyPrefix(p.closeIdempotencyKey as string));
    const exitLegAttempts = this.txAttempts ? await this.txAttempts.findByKeyPrefixes(closeKeys) : null;

    return deriveCapitalSnapshot(onChainBalance, deployedPositions, exitLegAttempts);
  }

  readOnChainUsdgBalance(): Promise<bigint> {
    return this.readBalance(this.walletAddress);
  }
}

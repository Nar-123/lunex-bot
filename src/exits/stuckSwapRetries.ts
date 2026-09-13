/**
 * H16 fix: `ExitStateRepository.findStuckSwapRetries` has no knowledge of
 * `Position.status` (by design -- `exits/` deliberately doesn't depend on
 * `positions/`'s repository internals beyond the `PositionRecord` shape
 * already passed around everywhere), so it can only ever answer "which
 * ExitState rows have a high swapAttemptCount," not "which of those are
 * still actually stuck." A position whose swap eventually succeeded (or
 * that closed via a different path entirely) keeps its historical
 * `swapAttemptCount` forever -- without this filter, it would be reported
 * as stuck permanently, long after the exit fully completed.
 *
 * This is the single shared filter both `composition/exitCycle.ts`
 * (periodic surfacing) and `api/routes/stuck.ts` (on-demand `GET
 * /positions/stuck`) apply to the raw repository result, so the policy
 * ("only unresolved CLOSING swaps count as stuck") lives in exactly one
 * place.
 */
export function filterToClosingPositions(stuckSwapRetryPositionIds: string[], closingPositionIds: Iterable<string>): string[] {
  const closing = new Set(closingPositionIds);
  return stuckSwapRetryPositionIds.filter((id) => closing.has(id));
}

-- P1 fix: persist the swap attempt's already-accepted USDG increase so a
-- resumed verification (after a failed proceeds read) never re-reads a
-- balance that concurrent wallet activity may have moved.
-- Non-destructive: one nullable ADD COLUMN; existing rows keep NULL, which
-- means "balance check not yet passed for the current attempt" -- exactly
-- the pre-existing behaviour.
ALTER TABLE "ExitState" ADD COLUMN "swapVerifiedUsdgIncreaseRaw" TEXT;

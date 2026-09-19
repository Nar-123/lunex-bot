-- ExitState stale-writer fix: optimistic-concurrency version for ExitState,
-- incremented by exactly 1 on every write. Decision-state writes are a
-- compare-and-swap on it (`WHERE positionId = ? AND version = ?`), so a
-- worker holding an older snapshot can never overwrite newer exit state.
-- Additive, NOT NULL with a default: existing rows simply start at 1 --
-- no data rewrite, nothing dropped.
ALTER TABLE "ExitState" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

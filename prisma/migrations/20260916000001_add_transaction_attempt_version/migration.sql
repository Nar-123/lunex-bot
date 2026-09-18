-- P1-5 fix: optimistic-concurrency version for TransactionAttempt. Existing
-- rows default to 1 (matches what a fresh create() would set), so a stale
-- writer holding a pre-migration in-memory snapshot with no version tracked
-- simply omits expectedVersion and keeps the old unconditional behavior --
-- no data migration needed beyond the column default.
ALTER TABLE "TransactionAttempt" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

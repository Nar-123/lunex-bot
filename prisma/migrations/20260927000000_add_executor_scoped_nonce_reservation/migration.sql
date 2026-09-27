-- Executor-scoped, DB-enforced nonce reservation.
--
-- A nonce is only meaningful for ONE account, and this table outlives
-- PRIVATE_KEY. Before this migration, nonce state was global: after an executor
-- rotation the old wallet's history still constrained the new account. Scoping
-- by executorAddress fixes that -- existing rows stay NULL, which never equals a
-- current executor, so a rotated wallet inherits nothing.
--
-- Additive only: one nullable column, two indexes, one lock table. No data is
-- rewritten and no existing row changes meaning.
ALTER TABLE "TransactionAttempt" ADD COLUMN "executorAddress" TEXT;

CREATE INDEX "TransactionAttempt_executorAddress_nonce_idx"
  ON "TransactionAttempt"("executorAddress", "nonce");

-- The invariant, enforced by the database rather than by application logic, so
-- two separate PROCESSES cannot both hold the same (executor, nonce):
--
--   * rows with no nonce yet are not constrained;
--   * legacy rows (executorAddress IS NULL) are not constrained -- they belong
--     to a previous wallet and are scoped out of allocation anyway;
--   * a FAILED attempt that never signed (rawTx IS NULL) is EXCLUDED, because
--     its nonce was provably never used on-chain and must stay reclaimable --
--     the chain sits at that value forever, and allocating above it would leave
--     every later transaction stuck behind a hole nothing will fill;
--   * everything else -- active attempts, VERIFIED, and FAILED-after-signing --
--     is included, so a nonce that is in flight or already spent can never be
--     handed to a second attempt.
CREATE UNIQUE INDEX "TransactionAttempt_executor_nonce_unique"
  ON "TransactionAttempt"("executorAddress", "nonce")
  WHERE "executorAddress" IS NOT NULL
    AND "nonce" IS NOT NULL
    AND NOT ("status" = 'FAILED' AND "rawTx" IS NULL);

-- Write-lock escalation point for the reservation transaction (mirrors
-- CapitalLock). Singleton row, created on first use.
CREATE TABLE "NonceLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "touchedAt" DATETIME NOT NULL
);

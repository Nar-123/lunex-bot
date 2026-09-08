-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TransactionAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "idempotencyKey" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "txRequest" TEXT,
    "gasLimit" BIGINT,
    "gasPrice" BIGINT,
    "nonce" INTEGER,
    "rawTx" TEXT,
    "txHash" TEXT,
    "lastError" TEXT,
    "failureCode" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "firstAttemptedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_TransactionAttempt" ("createdAt", "gasLimit", "gasPrice", "id", "idempotencyKey", "lastError", "nonce", "purpose", "rawTx", "status", "txHash", "txRequest", "updatedAt") SELECT "createdAt", "gasLimit", "gasPrice", "id", "idempotencyKey", "lastError", "nonce", "purpose", "rawTx", "status", "txHash", "txRequest", "updatedAt" FROM "TransactionAttempt";
DROP TABLE "TransactionAttempt";
ALTER TABLE "new_TransactionAttempt" RENAME TO "TransactionAttempt";
CREATE UNIQUE INDEX "TransactionAttempt_idempotencyKey_key" ON "TransactionAttempt"("idempotencyKey");
CREATE INDEX "TransactionAttempt_status_idx" ON "TransactionAttempt"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

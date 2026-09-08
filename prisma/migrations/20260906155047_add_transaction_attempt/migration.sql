-- CreateTable
CREATE TABLE "TransactionAttempt" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "TransactionAttempt_idempotencyKey_key" ON "TransactionAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TransactionAttempt_status_idx" ON "TransactionAttempt"("status");

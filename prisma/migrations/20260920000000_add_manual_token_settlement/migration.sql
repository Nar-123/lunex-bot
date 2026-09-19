-- CreateTable
CREATE TABLE "ManualTokenSettlement" (
    "txHash" TEXT NOT NULL PRIMARY KEY,
    "positionId" TEXT NOT NULL,
    "closeIdempotencyKey" TEXT NOT NULL,
    "tokenDisposedRaw" TEXT NOT NULL,
    "usdgProceedsRaw" TEXT NOT NULL,
    "blockNumber" TEXT NOT NULL,
    "settledAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ManualTokenSettlement_positionId_key" ON "ManualTokenSettlement"("positionId");

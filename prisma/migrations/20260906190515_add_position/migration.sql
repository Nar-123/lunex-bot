-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "poolId" TEXT NOT NULL,
    "currency0" TEXT NOT NULL,
    "currency1" TEXT NOT NULL,
    "fee" INTEGER NOT NULL,
    "tickSpacing" INTEGER NOT NULL,
    "hooks" TEXT NOT NULL,
    "tickLower" INTEGER NOT NULL,
    "tickUpper" INTEGER NOT NULL,
    "positionTokenId" TEXT,
    "entryUsdgRaw" BIGINT NOT NULL,
    "entrySqrtPriceX96" TEXT NOT NULL,
    "entryTick" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "openIdempotencyKey" TEXT NOT NULL,
    "closeIdempotencyKey" TEXT,
    "openedAt" DATETIME,
    "closedAt" DATETIME,
    "closeReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Position_openIdempotencyKey_key" ON "Position"("openIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Position_closeIdempotencyKey_key" ON "Position"("closeIdempotencyKey");

-- CreateIndex
CREATE INDEX "Position_status_idx" ON "Position"("status");

-- CreateIndex
CREATE INDEX "Position_tokenAddress_status_idx" ON "Position"("tokenAddress", "status");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Position" (
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
    "entryUsdgRaw" TEXT NOT NULL,
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
INSERT INTO "new_Position" ("closeIdempotencyKey", "closeReason", "closedAt", "createdAt", "currency0", "currency1", "entrySqrtPriceX96", "entryTick", "entryUsdgRaw", "fee", "hooks", "id", "openIdempotencyKey", "openedAt", "poolId", "positionTokenId", "status", "tickLower", "tickSpacing", "tickUpper", "tokenAddress", "tokenDecimals", "tokenSymbol", "updatedAt") SELECT "closeIdempotencyKey", "closeReason", "closedAt", "createdAt", "currency0", "currency1", "entrySqrtPriceX96", "entryTick", "entryUsdgRaw", "fee", "hooks", "id", "openIdempotencyKey", "openedAt", "poolId", "positionTokenId", "status", "tickLower", "tickSpacing", "tickUpper", "tokenAddress", "tokenDecimals", "tokenSymbol", "updatedAt" FROM "Position";
DROP TABLE "Position";
ALTER TABLE "new_Position" RENAME TO "Position";
CREATE UNIQUE INDEX "Position_openIdempotencyKey_key" ON "Position"("openIdempotencyKey");
CREATE UNIQUE INDEX "Position_closeIdempotencyKey_key" ON "Position"("closeIdempotencyKey");
CREATE INDEX "Position_status_idx" ON "Position"("status");
CREATE INDEX "Position_tokenAddress_status_idx" ON "Position"("tokenAddress", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

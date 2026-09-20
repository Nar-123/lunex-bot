-- Operator-authorised DUST settlement: an accounting-only record of a TOKEN
-- residual abandoned because selling it costs more than it is worth. No txHash
-- and no proceeds -- nothing here claims a swap happened. Additive only.
CREATE TABLE "DustSettlement" (
    "positionId" TEXT NOT NULL PRIMARY KEY,
    "closeIdempotencyKey" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "residualTokenRaw" TEXT NOT NULL,
    "quotedUsdgRaw" TEXT NOT NULL,
    "thresholdUsdgRaw" TEXT NOT NULL,
    "quotedAt" DATETIME NOT NULL,
    "settledAt" DATETIME NOT NULL,
    "actor" TEXT NOT NULL,
    "requestId" TEXT
);

-- CreateTable
CREATE TABLE "BotSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "positionSizePct" REAL NOT NULL DEFAULT 0.35,
    "maxActivePositions" INTEGER NOT NULL DEFAULT 3,
    "hardStopLossPct" REAL NOT NULL DEFAULT -0.15,
    "trailingTpTriggerPct" REAL NOT NULL DEFAULT 0.05,
    "updatedAt" DATETIME NOT NULL
);

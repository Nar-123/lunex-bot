-- TIER 3 — Meridian exit-strategy alignment.
--
-- Three things happen here, in this order:
--   1. ExitState gains Safety Exit's drawdown state (rename + one new column).
--   2. The new PoolPriceSample table (Bollinger %B history) is created.
--   3. BotSettings' live thresholds are moved to the Meridian values --
--      both the column DEFAULTS (for any future row) and the EXISTING
--      singleton row, which would otherwise keep serving the old -15%/+5%
--      placeholders forever since defaults only apply at insert time.
--
-- Non-destructive: no column or row is dropped, and the renamed column
-- keeps its data (the old `pnlProtectionActivatedAt` armed on exactly the
-- same condition the new `safetyExitArmedAt` arms on -- PnL reaching -8%
-- -- so an already-armed position stays armed across this migration).

-- 1. ExitState: rename the PNL-Protection flag to Safety Exit's armed
-- flag, and add the max-drawdown tracker it arms against.
ALTER TABLE "ExitState" RENAME COLUMN "pnlProtectionActivatedAt" TO "safetyExitArmedAt";
ALTER TABLE "ExitState" ADD COLUMN "maxDrawdownPnlPct" REAL;

-- 2. Bollinger %B price history.
CREATE TABLE "PoolPriceSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poolId" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL
);
CREATE INDEX "PoolPriceSample_poolId_observedAt_idx" ON "PoolPriceSample"("poolId", "observedAt");
CREATE INDEX "PoolPriceSample_observedAt_idx" ON "PoolPriceSample"("observedAt");

-- 3. BotSettings: Meridian-aligned defaults, applied to the column
-- definition AND to the existing singleton row.
-- RedefineTables (the SQLite way to change a DEFAULT) preserves all data.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BotSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "positionSizePct" REAL NOT NULL DEFAULT 0.35,
    "maxActivePositions" INTEGER NOT NULL DEFAULT 3,
    "hardStopLossPct" REAL NOT NULL DEFAULT -0.06,
    "trailingTpTriggerPct" REAL NOT NULL DEFAULT 0.06,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_BotSettings" ("id", "paused", "positionSizePct", "maxActivePositions", "hardStopLossPct", "trailingTpTriggerPct", "updatedAt")
SELECT "id", "paused", "positionSizePct", "maxActivePositions", "hardStopLossPct", "trailingTpTriggerPct", "updatedAt" FROM "BotSettings";
DROP TABLE "BotSettings";
ALTER TABLE "new_BotSettings" RENAME TO "BotSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- The rows carried over above still hold the PRE-Tier-3 values. Move any
-- row still sitting on the old Lunex placeholders onto the Meridian
-- numbers. Deliberately scoped to the exact old defaults so an operator
-- who had consciously tuned these to something else keeps their value.
UPDATE "BotSettings" SET "hardStopLossPct" = -0.06 WHERE "hardStopLossPct" = -0.15;
UPDATE "BotSettings" SET "trailingTpTriggerPct" = 0.06 WHERE "trailingTpTriggerPct" = 0.05;

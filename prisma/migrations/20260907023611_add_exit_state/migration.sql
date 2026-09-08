-- CreateTable
CREATE TABLE "ExitState" (
    "positionId" TEXT NOT NULL PRIMARY KEY,
    "trailingPeakPnlPct" REAL,
    "drawdownConfirmStartedAt" DATETIME,
    "oorStartedAt" DATETIME,
    "pnlProtectionActivatedAt" DATETIME,
    "metricsFailureSince" DATETIME,
    "swapAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "pendingCloseReason" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ExitState_oorStartedAt_idx" ON "ExitState"("oorStartedAt");

-- CreateIndex
CREATE INDEX "ExitState_drawdownConfirmStartedAt_idx" ON "ExitState"("drawdownConfirmStartedAt");

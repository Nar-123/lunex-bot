-- CreateTable
CREATE TABLE "TokenCooldown" (
    "tokenAddress" TEXT NOT NULL PRIMARY KEY,
    "exitedAt" DATETIME NOT NULL,
    "cooldownEndsAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "TokenCooldown_cooldownEndsAt_idx" ON "TokenCooldown"("cooldownEndsAt");

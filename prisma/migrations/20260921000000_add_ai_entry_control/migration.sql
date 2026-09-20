-- AI Supervisor entry control: a separate, AI-owned entry pause flag on the
-- BotSettings singleton. Additive; existing rows start "not AI-paused".
ALTER TABLE "BotSettings" ADD COLUMN "aiEntryPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BotSettings" ADD COLUMN "aiEntryChangedAt" DATETIME;
ALTER TABLE "BotSettings" ADD COLUMN "aiEntryRequestId" TEXT;

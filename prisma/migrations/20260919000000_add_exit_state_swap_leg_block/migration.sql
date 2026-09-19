-- Unroutable TOKEN leg: durable, operator-visible record of WHY a CLOSING
-- position's TOKEN->USDG swap cannot currently proceed (the Trading API has
-- no quote for it, or the exit price-impact gate blocks it) and SINCE WHEN.
-- The position stays CLOSING and keeps retrying; nothing is closed, settled
-- or valued from these columns -- they only make the condition visible
-- after a restart and classifiable as OPERATOR_ACTION_REQUIRED.
-- Additive, nullable: existing rows are simply "not blocked".
ALTER TABLE "ExitState" ADD COLUMN "swapLegBlockedReason" TEXT;
ALTER TABLE "ExitState" ADD COLUMN "swapLegBlockedSince" DATETIME;
ALTER TABLE "ExitState" ADD COLUMN "swapLegLastCheckedAt" DATETIME;

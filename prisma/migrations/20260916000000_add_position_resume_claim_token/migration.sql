-- P0-1 fix: ownership token for Position.claimForResume()/releaseResumeClaim(),
-- closing the unconditional-release race (a stale worker could release a
-- newer worker's claim). NULL-safe default so existing rows are simply
-- "not currently claimed by anyone" after this migration.
ALTER TABLE "Position" ADD COLUMN "resumeClaimToken" TEXT;

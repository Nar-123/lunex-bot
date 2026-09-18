-- P1-1 fix: singleton advisory-lock row used by
-- PositionRepository.createIfCapitalAllows() to force immediate write-lock
-- escalation on its transaction (see schema.prisma's doc comment on
-- CapitalLock for why this is required for cross-process safety).
CREATE TABLE "CapitalLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "touchedAt" DATETIME NOT NULL
);

INSERT INTO "CapitalLock" ("id", "touchedAt") VALUES ('singleton', CURRENT_TIMESTAMP);

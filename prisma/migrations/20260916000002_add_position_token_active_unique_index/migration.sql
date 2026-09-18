-- P1-2 fix: DB-atomic enforcement of "1 token = 1 OPENING/ACTIVE/CLOSING
-- lifecycle at any moment" -- a partial unique index, not expressible in
-- Prisma's declarative schema.prisma @@unique syntax (which cannot express
-- a WHERE condition), so applied here as raw SQL. `tokenAddress` is always
-- stored lowercase (positionRepository.ts normalizes before every write),
-- so no case-sensitivity gap. CLOSED and FAILED are deliberately EXCLUDED
-- from the WHERE clause -- a token whose earlier position reached either
-- of those terminal states must remain free to open a brand new one.
CREATE UNIQUE INDEX "Position_tokenAddress_active_unique"
  ON "Position"("tokenAddress")
  WHERE "status" IN ('OPENING', 'ACTIVE', 'CLOSING');

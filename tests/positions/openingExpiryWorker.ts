// H3: a standalone worker run as a genuinely separate OS process (spawned
// by positionRepository.integration.test.ts) -- its own Node runtime,
// PrismaClient and driver adapter, sharing only the SQLite file. Calls the
// REAL `expireStaleOpening` once and prints the result as one JSON line.
//
// argv: [dbUrl, positionId, maxAgeMs, nowIso]
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPositionRepository } from '../../src/positions/positionRepository';

async function main(): Promise<void> {
  const [dbUrl, positionId, maxAgeMs, nowIso] = process.argv.slice(2) as [string, string, string, string];
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });
  try {
    const result = await new PrismaPositionRepository(prisma).expireStaleOpening(positionId, Number(maxAgeMs), new Date(nowIso));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ threw: err instanceof Error ? err.message : String(err) }) + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

void main();

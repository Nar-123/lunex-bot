import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../config';

/**
 * Prisma 7 removed implicit "reads DATABASE_URL from the schema and
 * connects" behavior entirely -- `new PrismaClient()` with no arguments
 * now throws ("A driver adapter is required to connect to your
 * database"), confirmed by actually running it. Every consumer must be
 * handed an explicit driver adapter, chosen here based on
 * `config.database.provider` so nothing outside `storage/` needs to know
 * which database engine is active -- matches the original design intent
 * (SQLite/Postgres switchable via one config value), just wired
 * differently than Prisma 6 and earlier required.
 *
 * NOTE: `config.database.provider` must still match `datasource.provider`
 * in `prisma/schema.prisma` -- that one remains a schema/migration-time
 * SQL-dialect choice (see the comment there), not something this factory
 * can switch at runtime. Picking the wrong adapter for the schema that
 * was actually migrated will fail loudly on first query, not silently.
 */
let cachedClient: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (cachedClient) return cachedClient;

  if (config.database.provider === 'sqlite') {
    const adapter = new PrismaBetterSqlite3({ url: config.database.url });
    cachedClient = new PrismaClient({ adapter });
  } else {
    const adapter = new PrismaPg({ connectionString: config.database.url });
    cachedClient = new PrismaClient({ adapter });
  }
  return cachedClient;
}

/** For tests: forces the next `getPrismaClient()` call to build a fresh client (e.g. against a different DATABASE_URL). */
export function resetPrismaClientCache(): void {
  cachedClient = undefined;
}

/**
 * Closes the underlying DB connection -- needed for a genuinely clean
 * process exit under the Postgres adapter specifically: an open `pg`
 * connection pool keeps Node's event loop alive indefinitely on its own,
 * so relying on "the process exits naturally once idle" (Module 9B's
 * graceful-shutdown design, see `composition/app.ts`) requires this to
 * run first. SQLite (`better-sqlite3`) is synchronous and never held the
 * event loop open this way, so this is a no-op in that mode beyond
 * clearing the cache -- called unconditionally either way, never
 * provider-specific. Never called if shutdown timed out with a cycle
 * still in flight (see `src/index.ts`) -- disconnecting mid-write would
 * be exactly the failure mode graceful shutdown exists to prevent.
 */
export async function disconnectPrismaClient(): Promise<void> {
  if (cachedClient) {
    await cachedClient.$disconnect();
    cachedClient = undefined;
  }
}

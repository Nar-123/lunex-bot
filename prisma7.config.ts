// Prisma 7 config -- separate from prisma/schema.prisma because Prisma 7
// removed `datasource.url` from the schema file entirely (verified: schema
// validation now rejects it outright, error code P1012). Migration/CLI
// commands (`prisma migrate dev`, `db push`, etc.) read the connection URL
// from here; the application's own runtime connection (storage/prismaClient.ts)
// is separate again -- it builds a driver adapter explicitly from
// `config.database`, since Prisma 7 also requires an explicit adapter to be
// passed to `new PrismaClient({ adapter })` at runtime (no more implicit
// "reads DATABASE_URL and connects" behavior).
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});

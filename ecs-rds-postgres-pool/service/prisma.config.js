// prisma.config.js
//
// Prisma 7 removed `datasource.url` from schema.prisma (P1012) and moved the
// connection URL here instead. This reads the same DATABASE_URL env var that
// src/config.js requires for the running service -- there is exactly one
// source of truth for the connection string, just two places that consume it.
//
// No default is provided: an offline command (prisma validate, prisma
// generate, prisma migrate diff --from-empty) doesn't need a real value, but
// the schema engine binary still requires *a* syntactically valid one to
// start, so callers must export a dummy DATABASE_URL for those commands. A
// real value belongs only in the deployed environment, never in this file.
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `prisma db seed` reads the command from HERE. Prisma 7 moved it off the
    // package.json "prisma" key, which the CLI now ignores in silence -- a
    // package.json that still declared a seed would advertise a command the
    // CLI reports as not configured.
    seed: 'node prisma/seed.js',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});

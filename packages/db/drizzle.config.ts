import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://leoos@localhost:5432/leoos',
  },
  strict: true,
  verbose: true,
} satisfies Config;

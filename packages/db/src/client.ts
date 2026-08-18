import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';
import { readDbConfig, type DbConfig } from './config.js';

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * Creates a database client.
 *
 * `apps/api` owns the single long-lived instance. `apps/web` has NO database
 * access at all (ADR-0001) — if this module is ever imported there, that is the
 * bug, not a configuration problem.
 */
export function createDatabase(config: DbConfig = readDbConfig()): {
  db: Database;
  sql: postgres.Sql;
  close: () => Promise<void>;
} {
  const sql = postgres(config.url, {
    max: config.max,
    ssl: config.ssl ? 'require' : false,
    connection: {
      statement_timeout: config.statementTimeoutMs,
      // Keeps `timestamptz` comparisons unambiguous regardless of server locale.
      timezone: 'UTC',
    },
    onnotice: () => {},
  });

  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

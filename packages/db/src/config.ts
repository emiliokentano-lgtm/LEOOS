/**
 * Database configuration.
 *
 * Fails at boot on a missing URL rather than at first query — a process that
 * cannot reach its database should not accept traffic (docs/architecture
 * /00-overview.md §6).
 */
export interface DbConfig {
  url: string;
  max: number;
  /** Statement timeout in ms; a runaway query must not hold a connection open. */
  statementTimeoutMs: number;
  ssl: boolean;
}

export function readDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and point it at a Postgres 16 instance.',
    );
  }
  return {
    url,
    max: Number(env.DATABASE_POOL_MAX ?? 10),
    statementTimeoutMs: Number(env.DATABASE_STATEMENT_TIMEOUT_MS ?? 15_000),
    ssl: env.DATABASE_SSL === 'true',
  };
}

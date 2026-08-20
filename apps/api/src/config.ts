import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Validated at boot: the process refuses to start on a missing secret rather
 * than failing at first use (docs/architecture/00-overview.md §6). A dispatch
 * API that cannot sign cookies should not accept traffic.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1),

  /** Comma-separated origins permitted to send state-changing requests. */
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  /** Shared secret the web tier presents on internal calls. */
  INTERNAL_API_TOKEN: z.string().min(16),

  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(720),   // 12 h
  SESSION_ABSOLUTE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(10080), // 7 d

  /** Argon2id parameters — OWASP 2024 baseline, tuned per host at deploy time. */
  ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  /**
   * Where live unit positions come from.
   *
   * Explicit rather than inferred from whether a game server happens to be
   * registered. "Is this map real?" must be answerable from configuration, not
   * from the current contents of a table.
   */
  POSITION_SOURCE: z.enum(['mock', 'fivem']).default('mock'),

  /**
   * Base64 32-byte key that encrypts FiveM ingest secrets at rest.
   *
   * Optional, because an installation with no game server has no use for it and
   * refusing to boot would make an optional integration a hard dependency. What
   * it must never do is silently degrade: without it, credentials cannot be
   * issued and signed requests cannot be verified, and both say so.
   *
   *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  LEOOS_FIVEM_SECRET_KEY: z.string().min(1).optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = Readonly<z.infer<typeof schema>> & { allowedOrigins: readonly string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const value = parsed.data;

  if (value.NODE_ENV === 'production' && value.ARGON2_MEMORY_KIB < 19456) {
    throw new Error('ARGON2_MEMORY_KIB is below the OWASP baseline for production.');
  }

  /**
   * Choosing the FiveM source without a key is a misconfiguration that would
   * otherwise present as "every game server is unauthenticated", which reads
   * like a bug in the resource rather than a missing variable here.
   */
  if (value.POSITION_SOURCE === 'fivem' && !value.LEOOS_FIVEM_SECRET_KEY) {
    throw new Error(
      'POSITION_SOURCE=fivem requires LEOOS_FIVEM_SECRET_KEY, which encrypts ingest ' +
        'secrets at rest. Without it no game server credential can be verified.',
    );
  }

  return {
    ...value,
    allowedOrigins: value.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

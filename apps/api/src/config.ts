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

  return {
    ...value,
    allowedOrigins: value.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

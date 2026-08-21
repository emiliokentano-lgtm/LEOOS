import { count, sql } from 'drizzle-orm';
import { gameServer, gameServerCredential, type Database } from '@leoos/db';
import type { MapSourceStatus, SystemComponent, SystemStatus } from '@leoos/contracts';
import type { AppConfig } from '../../config.js';
import { systemScale } from './overview.read.js';

/**
 * What this installation is actually running.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, AND THAT IS THE DESIGN
 *
 * "System configuration where appropriate" — the appropriate part is REPORTING
 * it. Editing a deployment's configuration from inside the application it
 * configures is a bootstrapping problem wearing a feature's clothes: the
 * database URL, the signing keys and the mail transport all have to be right
 * before the process can serve the screen that would edit them, and a setting
 * that can be changed from the browser is a setting an attacker with a session
 * can change from the browser.
 *
 * So this screen answers "what is in force", names where each value comes from,
 * and stops. Changing any of it is a deployment action.
 *
 * Every component reports the state it HAS. An adapter behind a mock says
 * `mock` in the same words the boot log uses — never a green light it has not
 * earned (engineering rules 35, 45).
 * ────────────────────────────────────────────────────────────────────────────
 */

export async function buildSystemStatus(
  db: Database,
  config: AppConfig,
  mapSource: MapSourceStatus,
  hasSecretBox: boolean,
): Promise<SystemStatus> {
  const [scale, servers] = await Promise.all([
    systemScale(db),
    gameServerSummary(db),
  ]);

  const components: SystemComponent[] = [
    {
      key: 'database',
      label: 'Database',
      // Reaching this line required a query, so the connection is not a claim.
      state: 'live',
      detail: `PostgreSQL — connected. ${scale.users} account(s), `
        + `${scale.organizations} organization(s).`,
      source: 'DATABASE_URL',
    },
    {
      key: 'mail',
      label: 'Mail delivery',
      /**
       * There is one transport and it is the console one.
       *
       * Reported as a mock rather than as configured, because an operator who
       * believes password resets are being delivered will not find out until
       * somebody locked out tells them — by which time the reset emails have
       * been going to a log file for weeks.
       */
      state: 'mock',
      detail: 'Console transport — messages are written to the server log and '
        + 'NOT delivered. Password resets and verification emails do not arrive.',
      source: 'createMailTransport(NODE_ENV)',
    },
    {
      key: 'map_source',
      label: 'Live position source',
      state: mapSource.kind === 'mock'
        ? 'mock'
        : (mapSource.connected ? 'live' : 'degraded'),
      detail: mapSource.detail,
      source: 'POSITION_SOURCE',
    },
    {
      key: 'map_tiles',
      label: 'Map base layer',
      state: mapSource.placeholderBaseLayer ? 'absent' : 'live',
      detail: mapSource.placeholderBaseLayer
        ? 'No licensed tile pyramid is installed; the map draws a coordinate grid '
          + 'instead of terrain. Unit positions and geometry are unaffected.'
        : 'Raster tiles are being served.',
      source: 'docs/architecture/05-map.md §3',
    },
    {
      key: 'fivem_ingest',
      label: 'FiveM ingest credentials',
      state: hasSecretBox
        ? (servers.withLiveCredential > 0 ? 'live' : 'absent')
        : 'absent',
      detail: hasSecretBox
        ? `${servers.total} game server(s) registered, ${servers.withLiveCredential} `
          + 'with a live credential.'
        : 'No encryption key is configured, so ingest credentials cannot be issued '
          + 'or verified. Set LEOOS_FIVEM_SECRET_KEY.',
      source: 'LEOOS_FIVEM_SECRET_KEY',
    },
    {
      key: 'realtime',
      label: 'Real-time transport',
      state: 'live',
      detail: 'WebSocket hub, in-process. Single node: subscriptions and the '
        + 'position store are not shared between API processes.',
      source: 'docs/architecture/03-realtime.md',
    },
    {
      key: 'session_store',
      label: 'Session store',
      state: 'live',
      detail: `Database-backed. Idle timeout ${config.SESSION_IDLE_TIMEOUT_MINUTES} min, `
        + `absolute cap ${config.SESSION_ABSOLUTE_TIMEOUT_MINUTES} min.`,
      source: 'SESSION_IDLE_TIMEOUT_MINUTES / SESSION_ABSOLUTE_TIMEOUT_MINUTES',
    },
    {
      key: 'rate_limiter',
      label: 'Rate limiting',
      state: 'live',
      detail: 'In-process token buckets. Single node: limits are per API process, '
        + 'so a horizontally scaled deployment multiplies every published limit.',
      source: 'apps/api/src/lib/rate-limit.ts',
    },
    {
      key: 'audit_log',
      label: 'Audit log',
      state: 'live',
      detail: `Append-only; the application role holds INSERT and SELECT only. `
        + `Approximately ${scale.auditEntries.toLocaleString('en-US')} entries.`,
      source: 'packages/db/migrations',
    },
  ];

  return {
    environment: config.NODE_ENV,
    mockAdaptersAllowed: process.env.ALLOW_MOCK_ADAPTERS === 'true',
    components,
    scale,
  };
}

async function gameServerSummary(db: Database): Promise<{
  total: number;
  withLiveCredential: number;
}> {
  const [total, live] = await Promise.all([
    db.select({ value: count() }).from(gameServer),
    db.execute<{ value: number }>(sql`
      SELECT count(DISTINCT gs.id)::int AS value
      FROM ${gameServer} gs
      JOIN ${gameServerCredential} c ON c.game_server_id = gs.id
      WHERE c.revoked_at IS NULL
        AND (c.expires_at IS NULL OR c.expires_at > now())
    `),
  ]);

  return {
    total: total[0]?.value ?? 0,
    withLiveCredential: live[0]?.value ?? 0,
  };
}

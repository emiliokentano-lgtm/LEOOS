import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from '@leoos/db';
import { loadConfig, type AppConfig } from './config.js';
import contextPlugin from './plugins/context.js';
import errorsPlugin from './plugins/errors.js';
import authPlugin from './plugins/auth.js';
import mapSourcePlugin from './plugins/map-source.js';
import realtimePlugin from './plugins/realtime.js';
import requestLimitPlugin from './plugins/request-limit.js';
import retentionPlugin from './plugins/retention.js';
import fivemPlugin from './plugins/fivem.js';
import authRoutes from './modules/auth/auth.routes.js';
import organizationRoutes from './modules/organizations/organization.routes.js';
import personnelRoutes from './modules/personnel/personnel.routes.js';
import roleRoutes from './modules/roles/role.routes.js';
import personRoutes from './modules/persons/person.routes.js';
import vehicleRoutes from './modules/vehicles/vehicle.routes.js';
import searchRoutes from './modules/search/search.routes.js';
import mapRoutes from './modules/map/map.routes.js';
import dispatchRoutes from './modules/dispatch/dispatch.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import notificationRoutes from './modules/notifications/notification.routes.js';
import fivemRoutes from './modules/fivem/fivem.routes.js';
import gameServerRoutes from './modules/fivem/gameserver.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import realtimeTicketRoutes from './realtime/ticket.routes.js';
import websocketRoutes from './realtime/ws.routes.js';
import type { MailTransport } from './modules/auth/mail.js';
import type { LivePositionStore } from './modules/map/sources/live-positions.js';
import type { PositionSource } from './modules/map/sources/position-source.js';

export interface BuildOptions {
  config?: AppConfig;
  db?: Database;
  mail?: MailTransport;
  /** Overrides the live position feed. Tests drive positions directly. */
  map?: { store?: LivePositionStore; source?: PositionSource };
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      /**
       * Redaction is configured at the logger, not left to call sites.
       * A password must never reach a log line even if some future handler
       * logs a whole request body by mistake.
       */
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'req.headers["x-leoos-internal"]',
          'req.body.password',
          'req.body.newPassword',
          'req.body.currentPassword',
          'password',
          'newPassword',
          'currentPassword',
          'passwordHash',
          'token',
          'tokenHash',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (request) => ({
          method: request.method,
          url: request.url,
          // Query strings can carry tokens; the path alone is enough to debug.
          remoteAddress: request.ip,
        }),
      },
    },
    trustProxy: true,
    bodyLimit: 256 * 1024,
    disableRequestLogging: config.NODE_ENV === 'test',
  });

  /**
   * An empty body with a JSON content-type parses as `{}`, not as an error.
   *
   * Fastify's default rejects it outright with FST_ERR_CTP_EMPTY_JSON_BODY. That
   * is defensible in the abstract and a nuisance in practice: every bodyless
   * action — leave unit, join unit, acknowledge panic, restore role — breaks the
   * moment a client sets a default JSON content-type, which most HTTP clients do.
   * It has already caused one round of bugs here (restore-role, set-default-role),
   * fixed by teaching one client to omit the header. This fixes it at the source
   * instead, so the next client does not have to know.
   *
   * Routes that genuinely require fields still reject `{}` — through their own
   * Zod schema, with a message naming the missing field rather than a transport
   * error code.
   */
  app.addContentTypeParser(
    'application/json', { parseAs: 'string' },
    (request, body: string, done) => {
      /**
       * The FiveM bridge signs a hash of the body it SENT.
       *
       * Re-serialising the parsed object would not reproduce it — key order,
       * number formatting and whitespace are all free to differ — so the exact
       * bytes are kept for those routes and only for those routes. Holding the
       * raw body of every request would be a per-request allocation the rest of
       * the API has no use for.
       */
      if (request.url.startsWith('/api/v1/fivem')) {
        request.rawBody = body ?? '';
      }

      if (body === undefined || body === null || body.trim() === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body) as unknown);
      } catch {
        done(new SyntaxError('The request body is not valid JSON.'), undefined);
      }
    },
  );

  await app.register(contextPlugin, { config, db: options.db, mail: options.mail });
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  /**
   * Immediately after auth: the budget is keyed on the user, so it needs the
   * identity hook to have run, and it must run before any route work begins.
   */
  await app.register(requestLimitPlugin);
  /**
   * Before the map source: `FiveMPositionSource` is chosen there, and the ingest
   * surface it serves needs the nonce store and the secret box to exist first.
   */
  await app.register(fivemPlugin, { config });
  // After the context plugin: the position source needs `app.db` to load the
  // unit roster it simulates.
  await app.register(mapSourcePlugin, { config, ...options.map });
  /**
   * After the map source: the location broadcaster reads `app.mapPositions`, and
   * the hub's visibility resolver reads `app.db`. Registering it earlier would
   * capture undefined decorators.
   */
  await app.register(realtimePlugin, { config });
  /**
   * Retention. Sweeps the two tables that grow per operator — see the plugin
   * for what is and is not deleted, and for why the audit log is not.
   */
  await app.register(retentionPlugin, {});

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await app.db.execute('SELECT 1' as never);
    return { status: 'ready', mail: { transport: app.mail.name, delivering: app.mail.delivers } };
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(organizationRoutes, { prefix: '/api/v1/organizations' });
  // Personnel hangs off the organization, so the organization id is a path
  // segment rather than a body field — see the module comment in
  // personnel.routes.ts.
  await app.register(personnelRoutes, {
    prefix: '/api/v1/organizations/:organizationId/personnel',
  });
  await app.register(roleRoutes, {
    prefix: '/api/v1/organizations/:organizationId/roles',
  });
  /**
   * Persons and vehicles are NOT nested under an organization. They are a shared
   * register — a citizen and a plate belong to the world, not to a department —
   * so access is decided by permission rather than by organization scope. See
   * the module comments in person.routes.ts and vehicle.routes.ts.
   */
  await app.register(personRoutes, { prefix: '/api/v1/persons' });
  await app.register(vehicleRoutes, { prefix: '/api/v1/vehicles' });
  /**
   * Global search spans every register, so it is not nested under any of them.
   * The categories it may read are resolved from the caller's permissions —
   * see modules/search/search.scope.ts.
   */
  await app.register(searchRoutes, { prefix: '/api/v1/search' });
  /**
   * The map spans organizations by design — a pursuit crossing a boundary is one
   * view, not two. Visibility is decided per caller in modules/map/map.scope.ts.
   */
  await app.register(mapRoutes, { prefix: '/api/v1/map' });
  /**
   * Dispatch spans organizations for the same reason the map does — a joint call
   * is one board, not two. Visibility and authority are resolved per caller in
   * modules/dispatch/dispatch.scope.ts.
   */
  await app.register(dispatchRoutes, { prefix: '/api/v1/dispatch' });
  /**
   * The dashboard is a summary of the dispatch data, composed from the same
   * reads and gated on the same permission — see modules/dashboard.
   */
  await app.register(dashboardRoutes, { prefix: '/api/v1/dashboard' });
  /**
   * Notifications.
   *
   * NOT nested under an organization, and not under dispatch: a person's
   * notification list spans every organization they belong to and every module
   * that can address them. Nesting it would make the URL claim a scope the
   * resource does not have.
   *
   * Every route here resolves its subject from the session — there is no user id
   * in any path, query or body — so the prefix carries no authorization meaning
   * of its own.
   */
  await app.register(notificationRoutes, { prefix: '/api/v1/notifications' });
  /**
   * Real-time is TWO surfaces, deliberately separate.
   *
   * `/api/v1/realtime/ticket` is an ordinary authenticated POST — it is where the
   * session cookie is read and a short-lived, single-use ticket is issued
   * (ADR-0013). `/ws` is the socket itself, and it is NOT under `/api/v1`: it is
   * not a versioned REST resource, it carries no cookie, and it authenticates
   * from its first message rather than from a header.
   */
  /**
   * FiveM ingest is TWO surfaces with two completely different auth models, and
   * they are registered separately so that stays visible.
   *
   * `/api/v1/fivem/*` is machine-to-machine: no session, no cookie, no CSRF —
   * every request is authenticated by an HMAC signature over its own body
   * (04-fivem-integration.md §3). `/api/v1/game-servers/*` is an ordinary
   * authenticated admin surface gated on `admin.game_servers`, and it is where
   * the credentials the other surface verifies are issued.
   */
  await app.register(fivemRoutes, { prefix: '/api/v1/fivem' });
  await app.register(gameServerRoutes, { prefix: '/api/v1/game-servers' });
  /**
   * Global administration.
   *
   * Registered like any other module rather than behind a blanket guard: each
   * route decides for itself which global capability it needs, so an audit
   * viewer reaches the log without reaching the account register.
   */
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(realtimeTicketRoutes, { prefix: '/api/v1/realtime' });
  await app.register(websocketRoutes);

  return app;
}

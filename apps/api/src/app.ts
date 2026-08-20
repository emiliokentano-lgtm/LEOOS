import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from '@leoos/db';
import { loadConfig, type AppConfig } from './config.js';
import contextPlugin from './plugins/context.js';
import errorsPlugin from './plugins/errors.js';
import authPlugin from './plugins/auth.js';
import mapSourcePlugin from './plugins/map-source.js';
import realtimePlugin from './plugins/realtime.js';
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
    (_request, body: string, done) => {
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
  // After the context plugin: the position source needs `app.db` to load the
  // unit roster it simulates.
  await app.register(mapSourcePlugin, { config, ...options.map });
  /**
   * After the map source: the location broadcaster reads `app.mapPositions`, and
   * the hub's visibility resolver reads `app.db`. Registering it earlier would
   * capture undefined decorators.
   */
  await app.register(realtimePlugin, { config });

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
   * Real-time is TWO surfaces, deliberately separate.
   *
   * `/api/v1/realtime/ticket` is an ordinary authenticated POST — it is where the
   * session cookie is read and a short-lived, single-use ticket is issued
   * (ADR-0013). `/ws` is the socket itself, and it is NOT under `/api/v1`: it is
   * not a versioned REST resource, it carries no cookie, and it authenticates
   * from its first message rather than from a header.
   */
  await app.register(realtimeTicketRoutes, { prefix: '/api/v1/realtime' });
  await app.register(websocketRoutes);

  return app;
}

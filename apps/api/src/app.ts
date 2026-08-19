import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from '@leoos/db';
import { loadConfig, type AppConfig } from './config.js';
import contextPlugin from './plugins/context.js';
import errorsPlugin from './plugins/errors.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './modules/auth/auth.routes.js';
import organizationRoutes from './modules/organizations/organization.routes.js';
import type { MailTransport } from './modules/auth/mail.js';

export interface BuildOptions {
  config?: AppConfig;
  db?: Database;
  mail?: MailTransport;
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

  await app.register(contextPlugin, { config, db: options.db, mail: options.mail });
  await app.register(errorsPlugin);
  await app.register(authPlugin);

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await app.db.execute('SELECT 1' as never);
    return { status: 'ready', mail: { transport: app.mail.name, delivering: app.mail.delivers } };
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(organizationRoutes, { prefix: '/api/v1/organizations' });

  return app;
}

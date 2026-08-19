import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@leoos/db';
import type { AppConfig } from '../config.js';
import { RateLimiter } from '../lib/rate-limit.js';
import { createMailTransport, type MailTransport } from '../modules/auth/mail.js';
import type { ResolvedIdentity } from '../modules/auth/context.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: Database;
    mail: MailTransport;
    limiter: RateLimiter;
  }
  interface FastifyRequest {
    requestId: string;
    /** Set by the auth plugin once a session resolves. */
    auth?: {
      sessionId: string;
      userId: string;
      identity: ResolvedIdentity;
      /** Active organization for this request, from the header or the default. */
      organizationId: string | null;
    };
  }
}

export interface ContextOptions {
  config: AppConfig;
  /** Injected by tests so they can share one connection and one mail spy. */
  db?: Database;
  mail?: MailTransport;
}

export default fp<ContextOptions>(async (app, opts) => {
  app.decorate('config', opts.config);

  let close: (() => Promise<void>) | undefined;
  if (opts.db) {
    app.decorate('db', opts.db);
  } else {
    const created = createDatabase({
      url: opts.config.DATABASE_URL,
      max: 10,
      statementTimeoutMs: 15_000,
      ssl: false,
    });
    app.decorate('db', created.db);
    close = created.close;
  }

  app.decorate('mail', opts.mail ?? createMailTransport(opts.config.NODE_ENV));

  const limiter = new RateLimiter();
  limiter.start();
  app.decorate('limiter', limiter);

  // Every request carries an id, propagated into logs and every audit row, so a
  // user-facing error message can be traced to exactly what happened.
  app.addHook('onRequest', async (request) => {
    const header = request.headers['x-request-id'];
    request.requestId = typeof header === 'string' && header.length <= 64 ? header : randomUUID();
    request.log = request.log.child({ requestId: request.requestId });
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.requestId);
  });

  app.addHook('onClose', async () => {
    limiter.stop();
    await close?.();
  });
});

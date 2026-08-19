import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError, RateLimitedError, ValidationError } from '../lib/errors.js';

/**
 * Central error handler.
 *
 * The client sees a stable code and a message chosen for it. The internal
 * message — which may name the exact reason a login failed — is logged and never
 * serialized (docs/architecture/02-authorization.md §B.8).
 */
export default fp(async (app) => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const validation = new ValidationError(
        error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
      request.log.info({ err: validation.detail }, 'request validation failed');
      return reply.status(400).send({
        error: { code: validation.code, message: 'Some fields need attention.', detail: validation.detail },
        requestId: request.requestId,
      });
    }

    if (error instanceof AppError) {
      const level = error.statusCode >= 500 ? 'error' : 'info';
      request.log[level]({ code: error.code, reason: error.message }, 'request refused');

      if (error instanceof RateLimitedError) {
        reply.header('retry-after', String(error.retryAfterSeconds));
      }

      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.publicMessage ?? 'Request could not be completed.',
          ...(error.detail !== undefined ? { detail: error.detail } : {}),
        },
        requestId: request.requestId,
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
      requestId: request.requestId,
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Not found.' },
      requestId: request.requestId,
    }),
  );
});

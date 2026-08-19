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

    /**
     * Framework errors carry their own status.
     *
     * Fastify raises a 4xx `FastifyError` for a malformed request — an empty
     * body under a JSON content-type, a payload over the limit, an unsupported
     * media type. Falling through to 500 told the caller the server had broken
     * when the request was at fault, which sends them looking in the wrong
     * place, and it hides a real 500 among the noise.
     *
     * Only the client-error range is passed through: a framework error at 5xx is
     * still ours, and still reported as such.
     */
    const framework = error as { statusCode?: unknown; code?: unknown };
    const status = typeof framework.statusCode === 'number' ? framework.statusCode : 500;
    if (status >= 400 && status < 500) {
      request.log.info(
        { code: framework.code, reason: (error as { message?: string }).message },
        'malformed request',
      );
      return reply.status(status).send({
        error: {
          code: typeof framework.code === 'string' ? framework.code : 'BAD_REQUEST',
          message: 'The request could not be read.',
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

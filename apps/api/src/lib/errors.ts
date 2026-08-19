/**
 * Error taxonomy.
 *
 * Two rules encoded here matter for security:
 *
 * 1. A resource the actor cannot even see returns 404, never 403 — a 403 would
 *    confirm the resource exists (docs/architecture/02-authorization.md §B.8).
 * 2. Authentication failures carry a generic client message. The specific reason
 *    is logged server-side and never returned, so responses cannot be used to
 *    enumerate accounts or probe account state.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
    /** Message safe to return to the client, if different from `message`. */
    readonly publicMessage?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(detail: unknown) {
    super(400, 'VALIDATION_FAILED', 'Request payload failed validation', detail);
  }
}

/** Deliberately identical for unknown user, wrong password and locked account. */
export class InvalidCredentialsError extends AppError {
  constructor(internalReason: string) {
    super(
      401,
      'INVALID_CREDENTIALS',
      `login refused: ${internalReason}`,
      undefined,
      'Incorrect username or password.',
    );
  }
}

export class UnauthenticatedError extends AppError {
  constructor(reason = 'no valid session') {
    super(401, 'UNAUTHENTICATED', reason, undefined, 'Authentication required.');
  }
}

export class ForbiddenError extends AppError {
  /**
   * `publicMessage` is for refusals whose REASON is a policy rather than a fact
   * about a resource — "this is reserved to global administrators" tells an
   * attacker nothing they could not read in the documentation, and telling the
   * legitimate user is far better than a blank denial. Anything that would
   * confirm a resource exists must NOT be passed here.
   */
  constructor(reason: string, detail?: unknown, publicMessage?: string) {
    super(403, 'FORBIDDEN', reason, detail, publicMessage ?? 'You do not have permission to do that.');
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'resource') {
    super(404, 'NOT_FOUND', `${what} not found`, undefined, 'Not found.');
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message, undefined, message);
  }
}

export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      429,
      'RATE_LIMITED',
      'rate limit exceeded',
      undefined,
      'Too many attempts. Please wait and try again.',
    );
  }
}

export class AccountStateError extends AppError {
  constructor(readonly state: string) {
    super(
      403,
      'ACCOUNT_UNAVAILABLE',
      `account state: ${state}`,
      { state },
      'This account is not available. Contact an administrator.',
    );
  }
}

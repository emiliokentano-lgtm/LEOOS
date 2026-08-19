import type { FastifyReply } from 'fastify';
import { CSRF_COOKIE, SESSION_COOKIE } from '../plugins/auth.js';
import type { AppConfig } from '../config.js';

/**
 * Cookie handling.
 *
 * `HttpOnly` keeps the session token out of reach of any script, so an XSS bug
 * cannot exfiltrate it. `SameSite=Lax` blocks the common CSRF shapes while still
 * allowing top-level navigation back into the app. `Secure` is set outside
 * development, where there is no TLS.
 */
function serialize(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; httpOnly: boolean; secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function setSessionCookies(
  reply: FastifyReply,
  config: AppConfig,
  input: { sessionToken: string; csrfToken: string; expiresAt: Date },
): void {
  const secure = config.NODE_ENV !== 'development' && config.NODE_ENV !== 'test';
  const maxAge = Math.max(1, Math.floor((input.expiresAt.getTime() - Date.now()) / 1000));

  reply.header('set-cookie', [
    serialize(SESSION_COOKIE, input.sessionToken, { maxAgeSeconds: maxAge, httpOnly: true, secure }),
    // Readable by script on purpose: the client must echo it back in a header
    // for the double-submit check. It authorises nothing by itself.
    serialize(CSRF_COOKIE, input.csrfToken, { maxAgeSeconds: maxAge, httpOnly: false, secure }),
  ]);
}

export function clearSessionCookies(reply: FastifyReply, config: AppConfig): void {
  const secure = config.NODE_ENV !== 'development' && config.NODE_ENV !== 'test';
  reply.header('set-cookie', [
    serialize(SESSION_COOKIE, '', { maxAgeSeconds: 0, httpOnly: true, secure }),
    serialize(CSRF_COOKIE, '', { maxAgeSeconds: 0, httpOnly: false, secure }),
  ]);
}

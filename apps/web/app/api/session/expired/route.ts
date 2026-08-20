import { NextResponse, type NextRequest } from 'next/server';
import { CSRF_COOKIE, ORG_COOKIE, SESSION_COOKIE } from '@/lib/api-client';

/**
 * Where a server-rendered screen sends a caller whose session is gone.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL
 *
 * The cookie and the session have separate lifetimes. The cookie sits in the
 * browser; the session lives in the database and can end without it — an idle
 * timeout, the absolute timeout, an administrator ending sessions, a revoked
 * account. When that happens the two halves of the guard disagree:
 *
 *   middleware      sees a cookie  → "authenticated"  → /login redirects to /dashboard
 *   the app layout  asks the API   → "no session"     → /dashboard redirects to /login
 *
 * which is a redirect loop the operator cannot escape, not even by navigating
 * to the sign-in page by hand. The browser gives up with ERR_TOO_MANY_REDIRECTS
 * and the application is simply unreachable until they clear site data.
 *
 * A Server Component cannot write a cookie, so it cannot fix this itself. This
 * Route Handler can: it clears the stale credentials and hands the caller to the
 * sign-in screen, which already knows how to say that a session expired.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function GET(request: NextRequest) {
  const next = request.nextUrl.searchParams.get('next') ?? '';

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  url.searchParams.set('reason', 'expired');
  // Only a same-site path is preserved, so this cannot be turned into an open
  // redirect by someone handing an operator a crafted link.
  if (next.startsWith('/') && !next.startsWith('//')) url.searchParams.set('next', next);

  const response = NextResponse.redirect(url);
  for (const cookie of [SESSION_COOKIE, CSRF_COOKIE, ORG_COOKIE]) {
    response.cookies.delete(cookie);
  }
  return response;
}

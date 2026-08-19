import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route protection at the edge.
 *
 * A cheap first gate: it checks only that a session COOKIE is present, because
 * middleware cannot reach the database and must not try. Whether the cookie is
 * valid, unexpired and attached to an active account is decided by the API on
 * every request — this exists to avoid rendering an authenticated shell for
 * someone who obviously has no session, not to make a security decision
 * (engineering rule 9).
 */
const SESSION_COOKIE = 'leoos_session';

/** Reachable without a session. Everything else requires one. */
const PUBLIC_PATHS = [
  '/login', '/register', '/forgot-password', '/reset-password', '/verify',
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE);
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!hasSessionCookie && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Preserve the destination so sign-in returns the operator where they were.
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  // Someone with a session has no business on the sign-in screen.
  if (hasSessionCookie && isPublic && pathname !== '/verify' && pathname !== '/reset-password') {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|map/tiles).*)'],
};

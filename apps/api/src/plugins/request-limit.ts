import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LIMITS } from '../lib/rate-limit.js';
import { RateLimitedError } from '../lib/errors.js';

/**
 * The authenticated request budget.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL
 *
 * Rate limiting had been applied where a request is a GUESS — login,
 * registration, password reset, the FiveM claim code — and nowhere else. That
 * is the right place to start, because those are the surfaces where volume is
 * an attack. It leaves the surfaces where volume is simply COST: an authenticated
 * operator, or a script holding an operator's cookie, could run the global
 * search as fast as the network allowed, and each of those is a trigram scan
 * across the largest tables in the installation.
 *
 * The threat is not really an attacker here. It is a browser extension, a
 * runaway `setInterval` in a future screen, or somebody leaving a tab open on a
 * page whose poll got its dependency array wrong. All three look identical from
 * the database's side, and all three are absorbed the same way.
 *
 * TWO BUDGETS, DELIBERATELY:
 *
 *   general — every authenticated /api/v1 request
 *   search  — the three endpoints that scan, on top of the general budget
 *
 * The second is not redundant. A page that legitimately makes 200 cheap reads a
 * minute should not also be entitled to 200 trigram scans.
 *
 * KEYED ON THE USER. See the note beside `LIMITS.general` — an IP budget on a
 * game community behind one NAT throttles the wrong person.
 *
 * WHAT THIS IS NOT: protection against a distributed flood, or against an
 * unauthenticated one. Those belong in front of the process, and the counters
 * here are per-process anyway (see `lib/rate-limit.ts`). This is a ceiling on
 * what one signed-in operator can cost.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Endpoints whose cost is a scan rather than an indexed lookup. */
const SEARCH_PATHS = ['/api/v1/search', '/api/v1/persons', '/api/v1/vehicles'];

function isSearch(request: FastifyRequest): boolean {
  // Only the LIST surfaces scan. `/api/v1/persons/<id>` is a primary-key read
  // and is left to the general budget, which is why this matches on the path
  // ending rather than on a prefix.
  const path = request.url.split('?')[0] ?? '';
  return SEARCH_PATHS.includes(path);
}

export default fp(async (app: FastifyInstance) => {
  app.addHook('onRequest', async (request) => {
    // Unauthenticated traffic is limited beside the routes that accept it, by
    // IP, because there is no user to key on. Nothing to do here.
    if (!request.auth) return;
    if (!request.url.startsWith('/api/v1')) return;

    const userId = request.auth.userId;

    const general = app.limiter.consume(
      `api:${userId}`, LIMITS.general.limit, LIMITS.general.windowSeconds,
    );
    if (!general.allowed) throw new RateLimitedError(general.retryAfterSeconds);

    if (request.method === 'GET' && isSearch(request)) {
      const search = app.limiter.consume(
        `search:${userId}`, LIMITS.search.limit, LIMITS.search.windowSeconds,
      );
      if (!search.allowed) throw new RateLimitedError(search.retryAfterSeconds);
    }
  });
});

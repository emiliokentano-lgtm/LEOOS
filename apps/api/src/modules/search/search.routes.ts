import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AUDIT_ACTIONS } from '@leoos/db';
import { writeAudit } from '../../lib/audit.js';
import {
  CATEGORY_QUERIES, type CategoryResult, type SearchHit,
} from './search.read.js';
import {
  GROUPED_LIMIT, MAX_CATEGORY_LIMIT, MIN_SEARCH_LENGTH, resolveSearchScope,
  SEARCH_CATEGORIES, type SearchCategory, type SearchScope,
} from './search.scope.js';

/**
 * Global search.
 *
 * ONE ENDPOINT, TWO MODES:
 *
 *   category=all  — grouped. Six small queries in parallel, five hits each,
 *                   plus a real total per category. This is what the palette
 *                   shows while the operator is still typing.
 *   category=X    — paged. One query, proper limit/offset, for when they have
 *                   decided which category they wanted.
 *
 * The security model lives in search.scope.ts; this route's job is to honour it
 * — which mostly means NOT going around it. Note there is no branch here that
 * names a category directly: the set of things to query comes from the scope,
 * so a category the caller cannot read is never dispatched to.
 */

const querySchema = z.object({
  q: z.string().min(1).max(120),
  category: z.enum(['all', ...SEARCH_CATEGORIES] as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_CATEGORY_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function meta(request: FastifyRequest) {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.requestId,
  };
}

/**
 * Records that a search happened, and what it reached.
 *
 * The design brief for this screen said it out loud: "who looked up whom" is a
 * question this system must be able to answer. A cross-entity search that
 * returns a person or a vehicle is the same kind of event as opening one, so it
 * is logged the same way — with the TERM and the categories that matched, never
 * the matched records themselves, which would turn the audit table into a second
 * copy of the register.
 *
 * Written on the pool, not in a transaction: a search is a read, and a failure
 * to record one must not deny an operator a lookup they are entitled to.
 */
async function auditSearch(
  app: FastifyInstance,
  request: FastifyRequest,
  scope: SearchScope,
  term: string,
  results: CategoryResult[],
): Promise<void> {
  const matched = results.filter((r) => r.total > 0);
  // Nothing found is not worth a row — it says nothing about anyone.
  if (matched.length === 0) return;

  await writeAudit(app.db, {
    action: AUDIT_ACTIONS.SEARCH_PERFORMED,
    actorUserId: scope.actorUserId,
    organizationId: scope.actorOrganizationId,
    entityType: 'search',
    entityId: null,
    metadata: {
      term,
      categories: matched.map((r) => `${r.category}:${r.total}`),
    },
    ...meta(request),
  }).catch(() => {});
}

export default async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireSession);

  app.get('/', async (request, reply) => {
    const query = querySchema.parse(request.query ?? {});
    const term = query.q.trim();

    const actor = app.actorContext(request);
    const scope = resolveSearchScope(actor, request.auth!.userId);

    /**
     * The categories the caller may search are reported even when the term is
     * too short, so the UI can render its filter chips before anything is typed.
     * Which categories EXIST for you is not a secret; what is in them is.
     */
    const available = SEARCH_CATEGORIES.filter((c) => scope.categories.has(c));

    // A minimum length, enforced server-side rather than trusted from the
    // client. One character against six trigram indexes is a scan of everything.
    if (term.length < MIN_SEARCH_LENGTH) {
      return reply.send({
        query: term,
        tooShort: true,
        minLength: MIN_SEARCH_LENGTH,
        available,
        results: [],
        total: 0,
      });
    }

    const requested = query.category && query.category !== 'all'
      ? [query.category as SearchCategory]
      : available;

    // A category the caller cannot search is dropped rather than refused: asking
    // for it explicitly must not answer "you are not allowed", which is itself a
    // statement about what exists.
    const targets = requested.filter((c) => scope.categories.has(c));

    const grouped = !query.category || query.category === 'all';
    const limit = grouped ? GROUPED_LIMIT : (query.limit ?? 25);
    const offset = grouped ? 0 : (query.offset ?? 0);

    const results = await Promise.all(
      targets.map((category) =>
        CATEGORY_QUERIES[category](app.db, scope, { term, limit, offset })),
    );

    await auditSearch(app, request, scope, term, results);

    const total = results.reduce((sum, r) => sum + r.total, 0);

    return reply.send({
      query: term,
      tooShort: false,
      minLength: MIN_SEARCH_LENGTH,
      available,
      grouped,
      limit,
      offset,
      total,
      results: results
        // An empty category is dropped from a GROUPED response so the palette
        // shows only what matched; a paged one keeps its shape so the screen can
        // say "no results in vehicles" rather than falling back to everything.
        .filter((r) => (grouped ? r.hits.length > 0 : true))
        .map((r) => ({
          category: r.category,
          total: r.total,
          hits: r.hits.map(toHitDto),
        })),
    });
  });
}

/**
 * The serialization boundary (engineering rule 16).
 *
 * Every field named. The category queries build their own hit shape, so this is
 * mostly a re-assertion — but it is the thing that stops a future `select *`
 * inside a category leaking a column nobody meant to publish.
 */
function toHitDto(hit: SearchHit) {
  return {
    category: hit.category,
    id: hit.id,
    title: hit.title,
    subtitle: hit.subtitle,
    facts: hit.facts,
    href: hit.href,
    organizationKey: hit.organizationKey,
    organizationColor: hit.organizationColor,
    badge: hit.badge,
  };
}

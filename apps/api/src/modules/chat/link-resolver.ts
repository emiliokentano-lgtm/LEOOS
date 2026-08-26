import { sql } from 'drizzle-orm';
import {
  MESSAGE_LINK_ENTITIES, type MessageLinkDto, type MessageLinkEntity,
} from '@leoos/contracts';
import type { Database } from '@leoos/db';
import type { SearchScope } from '../search/search.scope.js';

/**
 * Resolving what a message points at, FOR ONE VIEWER.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SECURITY CORE OF CHAT
 *
 * A link is a typed identifier. Two people reading the same message may
 * correctly see different things: a doctor sees a name where an officer sees
 * "not available to you". If this file gets it wrong, chat becomes a way to
 * read records through a side door, which is precisely what a link must never
 * be.
 *
 * So the rules are:
 *
 *   1. RESOLUTION REUSES `SearchScope`. It is already the object that answers
 *      "which categories may this caller read, and which organizations' rows",
 *      gated on the SAME permissions that gate each screen. A second set of
 *      rules here would be a second set to drift from the first.
 *
 *   2. AN UNRESOLVED LINK CARRIES NO IDENTIFIER. Not the entity id, not the
 *      author's `label_hint`, not a href. A label and a type, and clicking it
 *      does nothing. The DTO is a discriminated union so there is nowhere in
 *      the unresolved shape to put one.
 *
 *   3. NOT FOUND AND NOT PERMITTED ARE DIFFERENT, and both are reported.
 *      Collapsing them would be tidier and would tell a reader that a record
 *      they may not see does not exist, which is a lie they might act on.
 *
 * See docs/architecture/16-chat.md §2.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * BATCHED: one query per entity TYPE per page, never one per link. A page of
 * twenty messages carrying six links each costs at most five queries, not a
 * hundred and twenty.
 */

export interface RawLink {
  id: string;
  messageId: string;
  entityType: MessageLinkEntity;
  entityId: string;
  position: number;
}

/** A resolved label, or nothing when the row is gone. */
type Resolved = Map<string, string>;

function href(entityType: MessageLinkEntity, entityId: string): string | null {
  const template = MESSAGE_LINK_ENTITIES[entityType]?.hrefTemplate ?? null;
  if (template === null) return null;
  return template.replace(':id', entityId);
}

/**
 * `null` means the caller may not read this category AT ALL.
 *
 * Distinguished from an empty map, which means they may read it and none of
 * these rows exist. The caller turns the first into `not-permitted` and the
 * second into `not-found`.
 */
async function resolvePersons(
  db: Database, scope: SearchScope, ids: string[],
): Promise<Resolved | null> {
  if (!scope.categories.has('persons')) return null;
  const rows = await db.execute<{ id: string; label: string }>(sql`
    SELECT id, first_name || ' ' || last_name AS label
      FROM person
     WHERE id = ANY(${sql.param(ids)}::uuid[]) AND deleted_at IS NULL
  `);
  return new Map(rows.map((r) => [r.id, r.label]));
}

async function resolveVehicles(
  db: Database, scope: SearchScope, ids: string[],
): Promise<Resolved | null> {
  if (!scope.categories.has('vehicles')) return null;
  const rows = await db.execute<{ id: string; label: string }>(sql`
    SELECT id, plate || coalesce(' · ' || display_name, '') AS label
      FROM vehicle
     WHERE id = ANY(${sql.param(ids)}::uuid[]) AND deleted_at IS NULL
  `);
  return new Map(rows.map((r) => [r.id, r.label]));
}

/**
 * Incidents and units are ORGANIZATION-SCOPED as well as permission-gated.
 *
 * `dispatch.view` alone is not enough: an incident belonging to another agency
 * is not this caller's to see, and the organization filter is what says so. A
 * null `organizationIds` means unrestricted — a global administrator.
 */
async function resolveIncidents(
  db: Database, scope: SearchScope, ids: string[],
): Promise<Resolved | null> {
  if (!scope.categories.has('incidents')) return null;
  const orgFilter = scope.organizationIds === null
    ? sql`TRUE`
    : sql`organization_id = ANY(${sql.param(scope.organizationIds)}::uuid[])`;
  const rows = await db.execute<{ id: string; label: string }>(sql`
    SELECT id, number || ' · ' || title AS label
      FROM incident
     WHERE id = ANY(${sql.param(ids)}::uuid[]) AND deleted_at IS NULL AND ${orgFilter}
  `);
  return new Map(rows.map((r) => [r.id, r.label]));
}

async function resolveUnits(
  db: Database, scope: SearchScope, ids: string[],
): Promise<Resolved | null> {
  if (!scope.categories.has('units')) return null;
  const orgFilter = scope.organizationIds === null
    ? sql`TRUE`
    : sql`organization_id = ANY(${sql.param(scope.organizationIds)}::uuid[])`;
  const rows = await db.execute<{ id: string; label: string }>(sql`
    SELECT id, callsign AS label FROM unit
     WHERE id = ANY(${sql.param(ids)}::uuid[]) AND status = 'active' AND ${orgFilter}
  `);
  return new Map(rows.map((r) => [r.id, r.label]));
}

async function resolveMembers(
  db: Database, scope: SearchScope, ids: string[],
): Promise<Resolved | null> {
  if (!scope.categories.has('personnel')) return null;
  const orgFilter = scope.organizationIds === null
    ? sql`TRUE`
    : sql`m.organization_id = ANY(${sql.param(scope.organizationIds)}::uuid[])`;
  const rows = await db.execute<{ id: string; label: string }>(sql`
    SELECT m.id, coalesce(m.callsign::text || ' · ', '') || u.display_name AS label
      FROM organization_member m
      JOIN user_account u ON u.id = m.user_id
     WHERE m.id = ANY(${sql.param(ids)}::uuid[]) AND ${orgFilter}
  `);
  return new Map(rows.map((r) => [r.id, r.label]));
}

const RESOLVERS: Record<
  MessageLinkEntity,
  (db: Database, scope: SearchScope, ids: string[]) => Promise<Resolved | null>
> = {
  person: resolvePersons,
  vehicle: resolveVehicles,
  incident: resolveIncidents,
  unit: resolveUnits,
  member: resolveMembers,
};

/**
 * Turns raw link rows into what THIS viewer may see.
 *
 * Returns a map keyed by message id, so a caller assembles a page without
 * another pass.
 */
export async function resolveLinks(
  db: Database,
  scope: SearchScope,
  links: RawLink[],
): Promise<Map<string, MessageLinkDto[]>> {
  const byMessage = new Map<string, MessageLinkDto[]>();
  if (links.length === 0) return byMessage;

  // Group by TYPE, so each resolver runs once for the whole page.
  const idsByType = new Map<MessageLinkEntity, Set<string>>();
  for (const link of links) {
    const set = idsByType.get(link.entityType) ?? new Set<string>();
    set.add(link.entityId);
    idsByType.set(link.entityType, set);
  }

  const resolvedByType = new Map<MessageLinkEntity, Resolved | null>();
  await Promise.all(
    [...idsByType.entries()].map(async ([entityType, ids]) => {
      const resolver = RESOLVERS[entityType];
      // An entity type this build does not know resolves to nothing rather
      // than throwing — a newer client must not be able to 500 an older API.
      const result = resolver === undefined
        ? null
        : await resolver(db, scope, [...ids]);
      resolvedByType.set(entityType, result);
    }),
  );

  for (const link of links) {
    const resolved = resolvedByType.get(link.entityType);
    const list = byMessage.get(link.messageId) ?? [];

    if (resolved === null || resolved === undefined) {
      /**
       * NOT PERMITTED, and nothing else travels.
       *
       * No entity id, no href, no label the author supplied. The union has
       * nowhere to put them, which is the point: a future edit cannot
       * accidentally widen this branch.
       */
      list.push({
        id: link.id,
        entityType: link.entityType,
        position: link.position,
        resolved: false,
        reason: 'not-permitted',
      });
    } else {
      const label = resolved.get(link.entityId);
      if (label === undefined) {
        // They MAY read this category; the row is gone or is another
        // organization's. Reported as not-found, which is what it is to them.
        list.push({
          id: link.id,
          entityType: link.entityType,
          position: link.position,
          resolved: false,
          reason: 'not-found',
        });
      } else {
        list.push({
          id: link.id,
          entityType: link.entityType,
          position: link.position,
          resolved: true,
          entityId: link.entityId,
          label,
          href: href(link.entityType, link.entityId),
        });
      }
    }

    byMessage.set(link.messageId, list);
  }

  // Stable order, so a chip does not move between two renders of one message.
  for (const list of byMessage.values()) list.sort((a, b) => a.position - b.position);
  return byMessage;
}

import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  incident, organization, organizationMember, person, unit, userAccount, vehicle,
  type Database,
} from '@leoos/db';
import {
  MAX_CATEGORY_LIMIT, type SearchCategory, type SearchScope,
} from './search.scope.js';

/**
 * Cross-entity search queries.
 *
 * One function per category, each taking the caller's `SearchScope` and applying
 * it in SQL. None of them decides authorization — that was settled once, in
 * search.scope.ts — but each is responsible for expressing its own organization
 * restriction, because "which column carries the organization" differs per table
 * and only the query knows.
 *
 * Every predicate is written so a trigram index can serve it (migrations 0001
 * and 0004). A leading-wildcard `ILIKE` without one is a sequential scan, and
 * this screen issues six of them per keystroke pause.
 */

export interface SearchHit {
  category: SearchCategory;
  id: string;
  /** The line an operator reads first. */
  title: string;
  /** The line under it: what kind of thing this is. */
  subtitle: string | null;
  /** Short facts — DOB, phone, rank, callsign. Rendered as a dense row. */
  facts: string[];
  /** Where clicking it goes. */
  href: string;
  /** Organization tint, where the record has one. */
  organizationKey: string | null;
  organizationColor: string | null;
  /** Drives the badge on the row — priority, status, wanted. */
  badge: { label: string; tone: 'danger' | 'warning' | 'success' | 'neutral' } | null;
}

export interface CategoryResult {
  category: SearchCategory;
  hits: SearchHit[];
  total: number;
}

interface QueryOptions {
  term: string;
  limit: number;
  offset: number;
}

function bounded(limit: number): number {
  return Math.min(Math.max(1, limit), MAX_CATEGORY_LIMIT);
}

/**
 * The organization restriction, as a SQL fragment.
 *
 * `null` scope means unrestricted. An EMPTY scope means the caller belongs
 * nowhere, and must match nothing — expressed as `false` rather than as an
 * empty `IN ()`, which is a syntax error in Postgres and, worse, is easy to
 * write accidentally as "no restriction".
 */
function orgRestriction(
  column: Parameters<typeof inArray>[0],
  scope: SearchScope,
  options: { allowNull?: boolean } = {},
) {
  if (scope.organizationIds === null) return undefined;
  if (scope.organizationIds.length === 0) return sql`false`;
  const inScope = inArray(column, scope.organizationIds);
  // A multi-agency record with no owning organization is visible to everyone
  // who can see the category at all — that is what "multi-agency" means.
  return options.allowNull ? or(inScope, isNull(column)) : inScope;
}

// ── Persons ────────────────────────────────────────────────────────────────

export async function searchPersonsCategory(
  db: Database,
  scope: SearchScope,
  { term, limit, offset }: QueryOptions,
): Promise<CategoryResult> {
  const like = `%${term}%`;
  const where = and(
    scope.includeArchivedPersons ? undefined : isNull(person.deletedAt),
    or(
      sql`(${person.firstName} || ' ' || ${person.lastName}) ILIKE ${like}`,
      sql`${person.phoneNumber} ILIKE ${like}`,
      sql`EXISTS (SELECT 1 FROM person_alias pa
            WHERE pa.person_id = ${person.id} AND pa.alias ILIKE ${like})`,
    ),
  );

  const totals = await db.select({ n: sql<number>`count(*)::int` }).from(person).where(where);

  const rows = await db
    .select({
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      dateOfBirth: person.dateOfBirth,
      phoneNumber: person.phoneNumber,
      status: person.status,
      deletedAt: person.deletedAt,
      wanted: sql<boolean>`EXISTS (
        SELECT 1 FROM warrant w
        WHERE w.person_id = ${sql.raw('"person"."id"')} AND w.status = 'active')`,
    })
    .from(person)
    .where(where)
    .orderBy(asc(person.lastName), asc(person.firstName), asc(person.id))
    .limit(bounded(limit))
    .offset(offset);

  return {
    category: 'persons',
    total: Number(totals[0]?.n ?? 0),
    hits: rows.map((r) => ({
      category: 'persons' as const,
      id: r.id,
      title: `${r.firstName} ${r.lastName}`,
      subtitle: r.deletedAt ? 'Citizen · archived record' : 'Citizen',
      facts: [
        r.dateOfBirth ? `DOB ${r.dateOfBirth}` : null,
        r.phoneNumber,
        r.status !== 'alive' ? r.status : null,
      ].filter((f): f is string => Boolean(f)),
      href: `/persons?search=${encodeURIComponent(`${r.firstName} ${r.lastName}`)}`,
      organizationKey: null,
      organizationColor: null,
      badge: r.wanted ? { label: 'Wanted', tone: 'danger' as const } : null,
    })),
  };
}

// ── Vehicles ───────────────────────────────────────────────────────────────

export async function searchVehiclesCategory(
  db: Database,
  scope: SearchScope,
  { term, limit, offset }: QueryOptions,
): Promise<CategoryResult> {
  const like = `%${term}%`;
  const where = and(
    scope.includeArchivedVehicles ? undefined : isNull(vehicle.deletedAt),
    or(
      sql`${vehicle.plate}::text ILIKE ${like}`,
      sql`${vehicle.model} ILIKE ${like}`,
      sql`${vehicle.displayName} ILIKE ${like}`,
    ),
  );

  const totals = await db.select({ n: sql<number>`count(*)::int` }).from(vehicle).where(where);

  const rows = await db
    .select({
      id: vehicle.id,
      plate: vehicle.plate,
      model: vehicle.model,
      displayName: vehicle.displayName,
      color: vehicle.color,
      registrationStatus: vehicle.registrationStatus,
      isFleet: vehicle.isFleet,
      deletedAt: vehicle.deletedAt,
      ownerName: sql<string | null>`(
        SELECT p.first_name || ' ' || p.last_name FROM person p
        WHERE p.id = ${sql.raw('"vehicle"."owner_person_id"')})`,
      organizationKey: sql<string | null>`(
        SELECT o.key::text FROM organization o
        WHERE o.id = ${sql.raw('"vehicle"."owner_organization_id"')})`,
      organizationColor: sql<string | null>`(
        SELECT o.color FROM organization o
        WHERE o.id = ${sql.raw('"vehicle"."owner_organization_id"')})`,
    })
    .from(vehicle)
    .where(where)
    .orderBy(asc(vehicle.plate), asc(vehicle.id))
    .limit(bounded(limit))
    .offset(offset);

  return {
    category: 'vehicles',
    total: Number(totals[0]?.n ?? 0),
    hits: rows.map((r) => ({
      category: 'vehicles' as const,
      id: r.id,
      title: r.plate,
      subtitle: r.displayName ?? r.model,
      facts: [
        r.color,
        r.model !== r.displayName ? r.model : null,
        r.ownerName ? `Owner: ${r.ownerName}` : null,
        r.isFleet ? 'Fleet' : null,
        r.deletedAt ? 'archived' : null,
      ].filter((f): f is string => Boolean(f)),
      href: `/vehicles?search=${encodeURIComponent(r.plate)}`,
      organizationKey: r.organizationKey,
      organizationColor: r.organizationColor,
      badge: r.registrationStatus !== 'registered'
        ? { label: r.registrationStatus, tone: 'warning' as const }
        : null,
    })),
  };
}

// ── Personnel ──────────────────────────────────────────────────────────────

/**
 * Organization-scoped, and this is the one most likely to leak.
 *
 * Personnel are the people behind the accounts. Without the restriction, typing
 * a surname into the search box would enumerate every department's roster —
 * exactly the thing the personnel screen refuses to do.
 */
export async function searchPersonnelCategory(
  db: Database,
  scope: SearchScope,
  { term, limit, offset }: QueryOptions,
): Promise<CategoryResult> {
  const like = `%${term}%`;
  const where = and(
    orgRestriction(organizationMember.organizationId, scope),
    ne(organizationMember.status, 'terminated'),
    or(
      sql`${userAccount.displayName} ILIKE ${like}`,
      sql`${userAccount.username}::text ILIKE ${like}`,
      sql`${organizationMember.callsign}::text ILIKE ${like}`,
      sql`${organizationMember.employeeNumber}::text ILIKE ${like}`,
    ),
  );

  const totals = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(organizationMember)
    .innerJoin(userAccount, eq(userAccount.id, organizationMember.userId))
    .where(where);

  const rows = await db
    .select({
      id: organizationMember.id,
      displayName: userAccount.displayName,
      callsign: organizationMember.callsign,
      employeeNumber: organizationMember.employeeNumber,
      status: organizationMember.status,
      organizationKey: organization.key,
      organizationName: organization.name,
      organizationColor: organization.color,
      rankName: sql<string | null>`(
        SELECT r.name FROM member_role mr JOIN role r ON r.id = mr.role_id
        WHERE mr.member_id = ${organizationMember.id} AND r.deleted_at IS NULL
        ORDER BY r.hierarchy_level DESC LIMIT 1)`,
    })
    .from(organizationMember)
    .innerJoin(userAccount, eq(userAccount.id, organizationMember.userId))
    .innerJoin(organization, eq(organization.id, organizationMember.organizationId))
    .where(where)
    .orderBy(asc(userAccount.displayName), asc(organizationMember.id))
    .limit(bounded(limit))
    .offset(offset);

  return {
    category: 'personnel',
    total: Number(totals[0]?.n ?? 0),
    hits: rows.map((r) => ({
      category: 'personnel' as const,
      id: r.id,
      title: r.rankName ? `${r.rankName} ${r.displayName}` : r.displayName,
      subtitle: r.organizationName,
      facts: [
        r.rankName ? `Rank: ${r.rankName}` : null,
        r.callsign ? `Callsign: ${r.callsign}` : null,
        r.employeeNumber ? `No. ${r.employeeNumber}` : null,
      ].filter((f): f is string => Boolean(f)),
      href: `/personnel?search=${encodeURIComponent(r.displayName)}`,
      organizationKey: r.organizationKey,
      organizationColor: r.organizationColor,
      badge: r.status !== 'active'
        ? { label: r.status.replace('_', ' '), tone: 'warning' as const }
        : null,
    })),
  };
}

// ── Organizations ──────────────────────────────────────────────────────────

export async function searchOrganizationsCategory(
  db: Database,
  scope: SearchScope,
  { term, limit, offset }: QueryOptions,
): Promise<CategoryResult> {
  const like = `%${term}%`;
  const where = and(
    isNull(organization.deletedAt),
    orgRestriction(organization.id, scope),
    or(
      sql`${organization.name} ILIKE ${like}`,
      sql`${organization.key}::text ILIKE ${like}`,
      sql`${organization.shortName} ILIKE ${like}`,
    ),
  );

  const totals = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(organization)
    .where(where);

  const rows = await db
    .select({
      id: organization.id,
      key: organization.key,
      name: organization.name,
      shortName: organization.shortName,
      category: organization.category,
      color: organization.color,
      isActive: organization.isActive,
      memberCount: sql<number>`(
        SELECT count(*) FROM organization_member m
        WHERE m.organization_id = ${sql.raw('"organization"."id"')}
          AND m.status = 'active')::int`,
    })
    .from(organization)
    .where(where)
    .orderBy(asc(organization.name), asc(organization.id))
    .limit(bounded(limit))
    .offset(offset);

  return {
    category: 'organizations',
    total: Number(totals[0]?.n ?? 0),
    hits: rows.map((r) => ({
      category: 'organizations' as const,
      id: r.id,
      title: r.name,
      subtitle: r.category.replace('_', ' '),
      facts: [
        r.shortName,
        `${Number(r.memberCount)} active member(s)`,
      ].filter((f): f is string => Boolean(f)),
      href: '/organization',
      organizationKey: r.key,
      organizationColor: r.color,
      badge: r.isActive ? null : { label: 'Disabled', tone: 'warning' as const },
    })),
  };
}

// ── Units ──────────────────────────────────────────────────────────────────

export async function searchUnitsCategory(
  db: Database,
  scope: SearchScope,
  { term, limit, offset }: QueryOptions,
): Promise<CategoryResult> {
  const like = `%${term}%`;
  const where = and(
    orgRestriction(unit.organizationId, scope),
    eq(unit.status, 'active'),
    or(
      sql`${unit.callsign}::text ILIKE ${like}`,
      sql`${unit.name} ILIKE ${like}`,
      sql`${unit.unitType} ILIKE ${like}`,
    ),
  );

  const totals = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(unit)
    .where(where);

  const rows = await db
    .select({
      id: unit.id,
      callsign: unit.callsign,
      name: unit.name,
      unitType: unit.unitType,
      statusKey: unit.statusKey,
      organizationKey: organization.key,
      organizationName: organization.name,
      organizationColor: organization.color,
      memberCount: sql<number>`(
        SELECT count(*) FROM unit_member um
        WHERE um.unit_id = ${unit.id} AND um.left_at IS NULL)::int`,
    })
    .from(unit)
    .innerJoin(organization, eq(organization.id, unit.organizationId))
    .where(where)
    .orderBy(asc(unit.callsign), asc(unit.id))
    .limit(bounded(limit))
    .offset(offset);

  return {
    category: 'units',
    total: Number(totals[0]?.n ?? 0),
    hits: rows.map((r) => ({
      category: 'units' as const,
      id: r.id,
      title: r.callsign,
      subtitle: r.name ?? `${r.unitType} unit`,
      facts: [
        r.organizationName,
        `${Number(r.memberCount)} member(s)`,
      ].filter((f): f is string => Boolean(f)),
      href: '/dispatch',
      organizationKey: r.organizationKey,
      organizationColor: r.organizationColor,
      badge: { label: r.statusKey.replace('_', ' '), tone: 'neutral' as const },
    })),
  };
}

// ── Incidents ──────────────────────────────────────────────────────────────

const PRIORITY_TONE = (priority: number): 'danger' | 'warning' | 'neutral' =>
  priority <= 2 ? 'danger' : priority === 3 ? 'warning' : 'neutral';

export async function searchIncidentsCategory(
  db: Database,
  scope: SearchScope,
  { term, limit, offset }: QueryOptions,
): Promise<CategoryResult> {
  const like = `%${term}%`;
  const where = and(
    isNull(incident.deletedAt),
    // `allowNull`: an incident with no owning organization is a genuinely
    // multi-agency call, and hiding it would be the wrong kind of scoping.
    orgRestriction(incident.organizationId, scope, { allowNull: true }),
    or(
      sql`${incident.number}::text ILIKE ${like}`,
      sql`${incident.title} ILIKE ${like}`,
      sql`${incident.locationText} ILIKE ${like}`,
    ),
  );

  const totals = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(incident)
    .where(where);

  const rows = await db
    .select({
      id: incident.id,
      number: incident.number,
      title: incident.title,
      priority: incident.priority,
      status: incident.status,
      locationText: incident.locationText,
      createdAt: incident.createdAt,
      typeKey: incident.typeKey,
      organizationKey: sql<string | null>`(
        SELECT o.key::text FROM organization o
        WHERE o.id = ${sql.raw('"incident"."organization_id"')})`,
      organizationColor: sql<string | null>`(
        SELECT o.color FROM organization o
        WHERE o.id = ${sql.raw('"incident"."organization_id"')})`,
    })
    .from(incident)
    .where(where)
    // Open calls first, worst priority first — an operator searching during a
    // shift wants the live one, not the closed one from last week.
    .orderBy(
      asc(sql`CASE WHEN ${incident.status} IN ('closed', 'cancelled') THEN 1 ELSE 0 END`),
      asc(incident.priority),
      desc(incident.createdAt),
      asc(incident.id),
    )
    .limit(bounded(limit))
    .offset(offset);

  return {
    category: 'incidents',
    total: Number(totals[0]?.n ?? 0),
    hits: rows.map((r) => ({
      category: 'incidents' as const,
      id: r.id,
      title: r.number,
      subtitle: r.title,
      facts: [
        `Priority: P${r.priority}`,
        `Status: ${r.status.replace('_', ' ')}`,
        r.locationText,
      ].filter((f): f is string => Boolean(f)),
      href: '/dispatch',
      organizationKey: r.organizationKey,
      organizationColor: r.organizationColor,
      badge: { label: `P${r.priority}`, tone: PRIORITY_TONE(r.priority) },
    })),
  };
}

// ── Dispatch table ─────────────────────────────────────────────────────────

type CategoryQuery = (
  db: Database, scope: SearchScope, options: QueryOptions,
) => Promise<CategoryResult>;

/**
 * The category table.
 *
 * Keeping the six behind one map means the route never names a category
 * directly, so a category can never be added to the API without also being
 * added to the scope resolver — the wiring makes the omission impossible rather
 * than merely unlikely.
 */
export const CATEGORY_QUERIES: Record<SearchCategory, CategoryQuery> = {
  persons: searchPersonsCategory,
  vehicles: searchVehiclesCategory,
  personnel: searchPersonnelCategory,
  organizations: searchOrganizationsCategory,
  units: searchUnitsCategory,
  incidents: searchIncidentsCategory,
};

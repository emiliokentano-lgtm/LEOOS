import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { auditLog, organization, person, vehicle, vehicleFlag, type Database } from '@leoos/db';

/**
 * Vehicle reads.
 *
 * Like persons, the vehicle register is SHARED across organizations — a plate is
 * looked up by whoever stops the car. Access is by permission. The one piece
 * that is organization-owned is a FLEET vehicle, and that ownership is enforced
 * on writes rather than hidden from reads: everyone should be able to see that
 * a unit belongs to MD.
 */


/**
 * The outer row's columns, EXPLICITLY QUALIFIED.
 *
 * Drizzle renders a column unqualified inside a SELECT projection when the query
 * has no joins, and a bare name inside a correlated subquery binds to the
 * SUBQUERY's table if that table has a column of the same name. `vehicle_flag`
 * has an `id`, so `vf.vehicle_id = "id"` became `vf.vehicle_id = vf.id` —
 * always false, no error, the flag count silently zero. See the matching note
 * in person.read.ts.
 */
const VEHICLE_ID = sql.raw('"vehicle"."id"');
const OWNER_PERSON_ID = sql.raw('"vehicle"."owner_person_id"');
const OWNER_ORG_ID = sql.raw('"vehicle"."owner_organization_id"');

export interface VehicleListItem {
  id: string;
  plate: string;
  model: string;
  displayName: string | null;
  color: string | null;
  vehicleClass: string | null;
  registrationStatus: string;
  insuranceStatus: string;
  isFleet: boolean;
  ownerPersonId: string | null;
  ownerName: string | null;
  ownerOrganizationId: string | null;
  ownerOrganizationKey: string | null;
  ownerOrganizationColor: string | null;
  flagCount: number;
  /** The owner's live warrants — the thing a traffic stop actually needs. */
  ownerHasWarrant: boolean;
  isArchived: boolean;
  createdAt: string;
}

export interface VehicleSearchFilters {
  search?: string;
  registrationStatus?: 'registered' | 'expired' | 'unregistered' | 'all';
  insuranceStatus?: 'insured' | 'uninsured' | 'expired' | 'all';
  ownerPersonId?: string;
  organizationId?: string;
  onlyFleet?: boolean;
  onlyFlagged?: boolean;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface VehiclePage {
  rows: VehicleListItem[];
  total: number;
}

export async function searchVehicles(
  db: Database,
  filters: VehicleSearchFilters = {},
): Promise<VehiclePage> {
  const term = filters.search?.trim();
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;
  const like = term ? `%${term}%` : null;

  const where = and(
    filters.includeArchived ? undefined : isNull(vehicle.deletedAt),
    filters.registrationStatus && filters.registrationStatus !== 'all'
      ? eq(vehicle.registrationStatus, filters.registrationStatus) : undefined,
    filters.insuranceStatus && filters.insuranceStatus !== 'all'
      ? eq(vehicle.insuranceStatus, filters.insuranceStatus) : undefined,
    filters.ownerPersonId ? eq(vehicle.ownerPersonId, filters.ownerPersonId) : undefined,
    filters.organizationId ? eq(vehicle.ownerOrganizationId, filters.organizationId) : undefined,
    filters.onlyFleet ? eq(vehicle.isFleet, true) : undefined,
    filters.onlyFlagged
      ? sql`EXISTS (SELECT 1 FROM vehicle_flag vf
            WHERE vf.vehicle_id = ${vehicle.id} AND vf.resolved_at IS NULL)`
      : undefined,
    term
      ? or(
          // Plate first and exact-prefix friendly: a partial plate read off a
          // dashcam is the single most common lookup in the system.
          sql`${vehicle.plate}::text ILIKE ${like}`,
          sql`${vehicle.plate}::text % ${term}`,
          sql`${vehicle.model} ILIKE ${like}`,
          sql`${vehicle.displayName} ILIKE ${like}`,
          sql`EXISTS (SELECT 1 FROM person p
                WHERE p.id = ${vehicle.ownerPersonId}
                  AND (p.first_name || ' ' || p.last_name) ILIKE ${like})`,
        )
      : undefined,
  );

  const totals = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(vehicle)
    .where(where);
  const total = Number(totals[0]?.total ?? 0);

  const rows = await db
    .select({
      id: vehicle.id,
      plate: vehicle.plate,
      model: vehicle.model,
      displayName: vehicle.displayName,
      color: vehicle.color,
      vehicleClass: vehicle.vehicleClass,
      registrationStatus: vehicle.registrationStatus,
      insuranceStatus: vehicle.insuranceStatus,
      isFleet: vehicle.isFleet,
      ownerPersonId: vehicle.ownerPersonId,
      ownerOrganizationId: vehicle.ownerOrganizationId,
      deletedAt: vehicle.deletedAt,
      createdAt: vehicle.createdAt,
      ownerName: sql<string | null>`(
        SELECT p.first_name || ' ' || p.last_name FROM person p
        WHERE p.id = ${OWNER_PERSON_ID})`,
      ownerOrganizationKey: sql<string | null>`(
        SELECT o.key::text FROM organization o WHERE o.id = ${OWNER_ORG_ID})`,
      ownerOrganizationColor: sql<string | null>`(
        SELECT o.color FROM organization o WHERE o.id = ${OWNER_ORG_ID})`,
      flagCount: sql<number>`(SELECT count(*) FROM vehicle_flag vf
        WHERE vf.vehicle_id = ${VEHICLE_ID} AND vf.resolved_at IS NULL)::int`,
      ownerHasWarrant: sql<boolean>`EXISTS (
        SELECT 1 FROM warrant w
        WHERE w.person_id = ${OWNER_PERSON_ID} AND w.status = 'active')`,
    })
    .from(vehicle)
    .where(where)
    // Flagged first — an operator scanning this list wants the exceptions.
    // `id` last so the sort is total and pages cannot overlap.
    .orderBy(
      desc(sql`(SELECT count(*) FROM vehicle_flag vf
        WHERE vf.vehicle_id = ${VEHICLE_ID} AND vf.resolved_at IS NULL)`),
      asc(vehicle.plate), asc(vehicle.id),
    )
    .limit(limit)
    .offset(offset);

  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      plate: r.plate,
      model: r.model,
      displayName: r.displayName,
      color: r.color,
      vehicleClass: r.vehicleClass,
      registrationStatus: r.registrationStatus,
      insuranceStatus: r.insuranceStatus,
      isFleet: r.isFleet,
      ownerPersonId: r.ownerPersonId,
      ownerName: r.ownerName,
      ownerOrganizationId: r.ownerOrganizationId,
      ownerOrganizationKey: r.ownerOrganizationKey,
      ownerOrganizationColor: r.ownerOrganizationColor,
      flagCount: Number(r.flagCount),
      ownerHasWarrant: Boolean(r.ownerHasWarrant),
      isArchived: r.deletedAt !== null,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export interface VehicleCore extends VehicleListItem {
  notes: string | null;
  archivedReason: string | null;
  updatedAt: string;
  createdByName: string | null;
  ownerStatus: string | null;
  ownerPhone: string | null;
  ownerOrganizationName: string | null;
}

export async function getVehicleCore(
  db: Database,
  vehicleId: string,
): Promise<VehicleCore | null> {
  const rows = await db
    .select({
      id: vehicle.id,
      plate: vehicle.plate,
      model: vehicle.model,
      displayName: vehicle.displayName,
      color: vehicle.color,
      vehicleClass: vehicle.vehicleClass,
      registrationStatus: vehicle.registrationStatus,
      insuranceStatus: vehicle.insuranceStatus,
      isFleet: vehicle.isFleet,
      notes: vehicle.notes,
      ownerPersonId: vehicle.ownerPersonId,
      ownerOrganizationId: vehicle.ownerOrganizationId,
      deletedAt: vehicle.deletedAt,
      deletionReason: vehicle.deletionReason,
      createdAt: vehicle.createdAt,
      updatedAt: vehicle.updatedAt,
      ownerName: sql<string | null>`(
        SELECT p.first_name || ' ' || p.last_name FROM person p
        WHERE p.id = ${OWNER_PERSON_ID})`,
      ownerStatus: sql<string | null>`(
        SELECT p.status::text FROM person p WHERE p.id = ${OWNER_PERSON_ID})`,
      ownerPhone: sql<string | null>`(
        SELECT p.phone_number FROM person p WHERE p.id = ${OWNER_PERSON_ID})`,
      ownerOrganizationKey: sql<string | null>`(
        SELECT o.key::text FROM organization o WHERE o.id = ${OWNER_ORG_ID})`,
      ownerOrganizationName: sql<string | null>`(
        SELECT o.name FROM organization o WHERE o.id = ${OWNER_ORG_ID})`,
      ownerOrganizationColor: sql<string | null>`(
        SELECT o.color FROM organization o WHERE o.id = ${OWNER_ORG_ID})`,
      createdByName: sql<string | null>`(
        SELECT u.display_name FROM user_account u
        WHERE u.id = ${sql.raw('"vehicle"."created_by"')})`,
      flagCount: sql<number>`(SELECT count(*) FROM vehicle_flag vf
        WHERE vf.vehicle_id = ${VEHICLE_ID} AND vf.resolved_at IS NULL)::int`,
      ownerHasWarrant: sql<boolean>`EXISTS (
        SELECT 1 FROM warrant w
        WHERE w.person_id = ${OWNER_PERSON_ID} AND w.status = 'active')`,
    })
    .from(vehicle)
    .where(eq(vehicle.id, vehicleId))
    .limit(1);

  const r = rows[0];
  if (!r) return null;

  return {
    id: r.id,
    plate: r.plate,
    model: r.model,
    displayName: r.displayName,
    color: r.color,
    vehicleClass: r.vehicleClass,
    registrationStatus: r.registrationStatus,
    insuranceStatus: r.insuranceStatus,
    isFleet: r.isFleet,
    notes: r.notes,
    ownerPersonId: r.ownerPersonId,
    ownerName: r.ownerName,
    ownerStatus: r.ownerStatus,
    ownerPhone: r.ownerPhone,
    ownerOrganizationId: r.ownerOrganizationId,
    ownerOrganizationKey: r.ownerOrganizationKey,
    ownerOrganizationName: r.ownerOrganizationName,
    ownerOrganizationColor: r.ownerOrganizationColor,
    createdByName: r.createdByName,
    flagCount: Number(r.flagCount),
    ownerHasWarrant: Boolean(r.ownerHasWarrant),
    isArchived: r.deletedAt !== null,
    archivedReason: r.deletionReason,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export interface VehicleFlagRow {
  id: string;
  type: string;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
  resolvedAt: string | null;
}

export async function listVehicleFlags(
  db: Database,
  vehicleId: string,
  includeResolved = true,
): Promise<VehicleFlagRow[]> {
  const rows = await db
    .select({
      id: vehicleFlag.id,
      type: vehicleFlag.type,
      note: vehicleFlag.note,
      createdAt: vehicleFlag.createdAt,
      resolvedAt: vehicleFlag.resolvedAt,
      createdByName: sql<string | null>`(
        SELECT u.display_name FROM user_account u WHERE u.id = ${vehicleFlag.createdBy})`,
    })
    .from(vehicleFlag)
    .where(and(
      eq(vehicleFlag.vehicleId, vehicleId),
      includeResolved ? undefined : isNull(vehicleFlag.resolvedAt),
    ))
    .orderBy(desc(vehicleFlag.createdAt));

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
  }));
}

/**
 * The record's own history, read from `audit_log`.
 *
 * Sourced from the audit trail rather than a second history table, so the two
 * cannot disagree — and so a refused attempt to change a registration appears
 * here alongside the ones that succeeded.
 */
export interface VehicleHistoryRow {
  at: string;
  action: string;
  actorName: string | null;
  outcome: string;
  summary: string | null;
}

export async function listVehicleHistory(
  db: Database,
  vehicleId: string,
): Promise<VehicleHistoryRow[]> {
  /**
   * Built with the query builder rather than raw SQL.
   *
   * `db.execute` on a raw statement returns an ALIASED column as a plain
   * string — the driver's type mapping is keyed on the real column, so
   * `occurred_at AS at` came back as text and `.toISOString()` threw. The
   * builder keeps the column types, and the bug cannot recur by inspection.
   */
  const rows = await db
    .select({
      at: auditLog.occurredAt,
      action: auditLog.action,
      outcome: auditLog.outcome,
      before: auditLog.before,
      after: auditLog.after,
      metadata: auditLog.metadata,
      actorName: sql<string | null>`(
        SELECT u.display_name FROM user_account u WHERE u.id = ${auditLog.actorUserId})`,
    })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'vehicle'), eq(auditLog.entityId, vehicleId)))
    .orderBy(desc(auditLog.occurredAt))
    .limit(50);

  return rows.map((r) => {
    const before = (r.before ?? {}) as Record<string, unknown>;
    const after = (r.after ?? {}) as Record<string, unknown>;
    const parts: string[] = [];

    for (const key of ['plate', 'registrationStatus', 'insuranceStatus', 'owner'] as const) {
      const from = before[key];
      const to = after[key];
      if (from !== undefined && to !== undefined && from !== to) {
        parts.push(`${key}: ${String(from)} → ${String(to)}`);
      }
    }
    const md = (r.metadata ?? {}) as Record<string, unknown>;
    if (typeof md.reason === 'string') parts.push(md.reason);
    if (typeof md.flagAdded === 'string') parts.push(`flag: ${md.flagAdded}`);

    return {
      at: r.at.toISOString(),
      action: r.action,
      actorName: r.actorName,
      outcome: r.outcome,
      summary: parts.length > 0 ? parts.join(' · ') : null,
    };
  });
}

/** Owner candidates for the editor — searched, never listed whole. */
export async function searchOwnerCandidates(
  db: Database,
  term: string,
): Promise<{ id: string; name: string; dateOfBirth: string | null }[]> {
  const like = `%${term.trim()}%`;
  const rows = await db
    .select({
      id: person.id,
      name: sql<string>`${person.firstName} || ' ' || ${person.lastName}`,
      dateOfBirth: person.dateOfBirth,
    })
    .from(person)
    .where(and(
      isNull(person.deletedAt),
      or(
        sql`(${person.firstName} || ' ' || ${person.lastName}) ILIKE ${like}`,
        sql`(${person.firstName} || ' ' || ${person.lastName}) % ${term}`,
      ),
    ))
    .orderBy(asc(person.lastName), asc(person.firstName))
    .limit(20);
  return rows;
}

/** Organizations the actor may assign a fleet vehicle to. */
export async function listOrganizationOptions(
  db: Database,
): Promise<{ id: string; key: string; name: string; color: string }[]> {
  return db
    .select({
      id: organization.id, key: organization.key,
      name: organization.name, color: organization.color,
    })
    .from(organization)
    .where(isNull(organization.deletedAt))
    .orderBy(asc(organization.name));
}

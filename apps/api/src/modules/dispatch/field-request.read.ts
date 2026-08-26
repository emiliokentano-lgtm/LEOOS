import { sql } from 'drizzle-orm';
import type { FieldRequestDto, FieldRequestKind, FieldRequestStatus } from '@leoos/contracts';
import type { Database } from '@leoos/db';
import type { DispatchScope } from './dispatch.scope.js';

/**
 * Reading field requests.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EXPIRY IS EVALUATED HERE, NOT BY A JOB
 *
 * `expires_at` is compared against the DATABASE's clock on every read, so a
 * request that has run out is dead the moment it runs out — no sweep has to
 * have caught it, and no client holding a stale prompt can act on it. The row
 * still says `pending` until something touches it, and that is fine: nothing
 * reads the status without also reading the deadline.
 *
 * The consequence worth naming: `status` in a DTO is the EFFECTIVE status. A
 * row that is `pending` past its deadline is reported as `expired`, because
 * that is what it is to everybody who can see it.
 * ────────────────────────────────────────────────────────────────────────────
 */

type Row = {
  id: string;
  kind: FieldRequestKind;
  status: FieldRequestStatus;
  expired: boolean;
  organization_id: string;
  org_key: string;
  org_name: string;
  org_short_name: string;
  org_category: string;
  org_color: string;
  member_id: string;
  asker_name: string;
  asker_callsign: string | null;
  asker_rank: string | null;
  unit_id: string | null;
  unit_callsign: string | null;
  incident_id: string | null;
  incident_number: string | null;
  pos_x: number | null;
  pos_y: number | null;
  note: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  accepted_by: string | null;
  declined_count: number;
  viewer_response: 'accepted' | 'declined' | null;
  viewer_is_asker: boolean;
};

function toDto(row: Row): FieldRequestDto {
  return {
    id: row.id,
    kind: row.kind,
    // The EFFECTIVE status: a pending row past its deadline is expired.
    status: row.status === 'pending' && row.expired ? 'expired' : row.status,
    organization: {
      id: row.organization_id,
      key: row.org_key,
      name: row.org_name,
      shortName: row.org_short_name,
      category: row.org_category as never,
      color: row.org_color,
    },
    asker: {
      memberId: row.member_id,
      displayName: row.asker_name,
      callsign: row.asker_callsign,
      rankLabel: row.asker_rank,
    },
    unitId: row.unit_id,
    unitCallsign: row.unit_callsign,
    incidentId: row.incident_id,
    incidentNumber: row.incident_number,
    x: row.pos_x,
    y: row.pos_y,
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    resolvedAt: row.resolved_at === null ? null : new Date(row.resolved_at).toISOString(),
    acceptedBy: row.accepted_by,
    declinedCount: Number(row.declined_count ?? 0),
    viewerResponse: row.viewer_response,
    viewerIsAsker: row.viewer_is_asker,
  };
}

/**
 * Everything live for the organizations this caller may see.
 *
 * Scoped by `scope.organizationIds`, which is derived from membership and
 * global capability — never from a parameter. A caller who may see two agencies
 * sees both; a caller who may see one sees one; and there is no argument that
 * changes that.
 */
export async function listLiveFieldRequests(
  db: Database,
  scope: DispatchScope,
): Promise<FieldRequestDto[]> {
  if (!scope.canView) return [];
  if (scope.organizationIds.length === 0 && !scope.canViewAllOrganizations) return [];

  const orgFilter = scope.canViewAllOrganizations
    ? sql`TRUE`
    /**
     * `sql.param` for the array, not a bare interpolation.
     *
     * Drizzle expands an interpolated JS array into one placeholder per
     * element, which is a syntax error inside `ANY(...)`. The rest of the
     * codebase already uses `sql.param` for exactly this; matching it rather
     * than inventing a third way.
     */
    : sql`fr.organization_id = ANY(${sql.param(scope.organizationIds)}::uuid[])`;

  const rows = await db.execute<Row>(sql`
    SELECT
      fr.id, fr.kind, fr.status,
      (fr.expires_at <= now()) AS expired,
      fr.organization_id,
      o.key AS org_key, o.name AS org_name, o.short_name AS org_short_name,
      o.category AS org_category, o.color AS org_color,
      fr.member_id,
      ua.display_name AS asker_name,
      m.callsign AS asker_callsign,
      (SELECT r.name FROM member_role mr
         JOIN role r ON r.id = mr.role_id
        WHERE mr.member_id = m.id
        ORDER BY r.hierarchy_level DESC LIMIT 1) AS asker_rank,
      fr.unit_id, u.callsign AS unit_callsign,
      fr.incident_id, i.number AS incident_number,
      fr.pos_x, fr.pos_y, fr.note,
      fr.created_at, fr.expires_at, fr.resolved_at,
      (SELECT ua2.display_name
         FROM organization_member m2
         JOIN user_account ua2 ON ua2.id = m2.user_id
        WHERE m2.id = fr.resolved_by) AS accepted_by,
      (SELECT count(*)::int FROM field_request_response rr
        WHERE rr.field_request_id = fr.id AND rr.response = 'declined') AS declined_count,
      (SELECT rr.response FROM field_request_response rr
         JOIN organization_member vm ON vm.id = rr.member_id
        WHERE rr.field_request_id = fr.id AND vm.user_id = ${scope.actorUserId}
        LIMIT 1) AS viewer_response,
      (m.user_id = ${scope.actorUserId}) AS viewer_is_asker
    FROM field_request fr
    JOIN organization o ON o.id = fr.organization_id
    JOIN organization_member m ON m.id = fr.member_id
    JOIN user_account ua ON ua.id = m.user_id
    LEFT JOIN unit u ON u.id = fr.unit_id
    LEFT JOIN incident i ON i.id = fr.incident_id
    WHERE fr.status = 'pending'
      AND fr.expires_at > now()
      AND ${orgFilter}
    ORDER BY fr.created_at DESC
    LIMIT 50
  `);

  return rows.map(toDto);
}

/**
 * A revision marker for field requests.
 *
 * Folded into the dispatch revision the board already polls, rather than given a
 * poll of its own: a screen that has to ask two questions to find out whether
 * anything changed will eventually show two different answers.
 */
export async function getFieldRequestRevision(
  db: Database,
  scope: DispatchScope,
): Promise<string> {
  if (scope.organizationIds.length === 0 && !scope.canViewAllOrganizations) return '0:0';

  const orgFilter = scope.canViewAllOrganizations
    ? sql`TRUE`
    : sql`organization_id = ANY(${sql.param(scope.organizationIds)}::uuid[])`;

  const [row] = await db.execute<{ at: string | null; n: number }>(sql`
    SELECT max(extract(epoch from updated_at))::text AS at,
           count(*) FILTER (WHERE status = 'pending' AND expires_at > now())::int AS n
      FROM field_request
     WHERE ${orgFilter}
  `);
  return `${row?.at ?? '0'}:${row?.n ?? 0}`;
}

import { sql } from 'drizzle-orm';
import type { Database } from '@leoos/db';

/**
 * WHO RECEIVES WHAT.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS THE SECURITY BOUNDARY OF THE NOTIFICATION SYSTEM
 *
 * A notification is a PUSH of information, so it is subject to exactly the same
 * visibility rules as a read. "FIB unit SIERRA-2 is in panic at Vespucci"
 * delivered to a PD officer leaks a covert unit's position as surely as putting
 * it on their map — more so, because it arrives unasked and is then stored in a
 * table they can read at leisure.
 *
 * Three rules hold everything here together:
 *
 *   1. RECIPIENTS ARE DERIVED, NEVER SUPPLIED. Every function below computes its
 *      audience from membership, duty status and permission. No caller passes a
 *      user id list, and no contract type has anywhere to put one.
 *
 *   2. THE PERMISSION CHECK IS THE SAME ONE THE SCREEN USES. A panic goes to
 *      people who hold `dispatch.view` in the organization the panic belongs to
 *      — the identical predicate that gates the `org:<id>:panic` topic and the
 *      dispatch board. If somebody could not have seen it by looking, they do
 *      not get told.
 *
 *   3. EVERY QUERY IS ORGANIZATION-SCOPED IN SQL. The scope comes from the
 *      resource, resolved inside the transaction — never from a request body
 *      (engineering rule 11).
 *
 * The effective-permission expression is written once, below, and reused. Two
 * copies of "does this member hold this permission" is how one of them ends up
 * missing the override table.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * A resolved recipient.
 *
 * A `type` rather than an `interface` deliberately: `db.execute<T>` requires a
 * type with an implicit index signature, which an interface does not have.
 */
export type Recipient = {
  userId: string;
  memberId: string;
};

/**
 * Does an ACTIVE member of this organization effectively hold a permission?
 *
 * Mirrors `effectivePermissions` in the kernel, in SQL:
 *
 *   · a role the member holds grants it, OR a member-level override grants it;
 *   · a member-level DENY override always wins;
 *   · an organization lead holds every organization-scoped permission;
 *   · a terminated or suspended member holds nothing.
 *
 * Expired overrides are excluded. An override that lapsed at noon grants nothing
 * at one o'clock, and a notification is a live decision.
 */
const HOLDS_PERMISSION = (permission: string) => sql`(
  -- Denies win outright, so they are checked first and independently.
  NOT EXISTS (
    SELECT 1 FROM member_permission_override mpo
     WHERE mpo.member_id = m.id
       AND mpo.permission_key = ${permission}
       AND mpo.effect = 'deny'
       AND (mpo.expires_at IS NULL OR mpo.expires_at > now())
  )
  AND (
    EXISTS (
      SELECT 1 FROM organization_lead ol
       WHERE ol.user_id = m.user_id
         AND ol.organization_id = m.organization_id
         AND ol.revoked_at IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM member_role mr
        JOIN role_permission rp ON rp.role_id = mr.role_id
       WHERE mr.member_id = m.id
         AND rp.permission_key = ${permission}
    )
    OR EXISTS (
      SELECT 1 FROM member_permission_override mpo
       WHERE mpo.member_id = m.id
         AND mpo.permission_key = ${permission}
         AND mpo.effect = 'grant'
         AND (mpo.expires_at IS NULL OR mpo.expires_at > now())
    )
  )
)`;

/**
 * Members of one organization holding a permission.
 *
 * The base audience for anything organization-wide. `excludeUserId` drops the
 * actor: telling somebody what they just did is noise, and on a panic it is
 * worse than noise — it buries the alert under a copy addressed to the person
 * already dealing with it.
 */
export async function membersWithPermission(
  tx: Database,
  organizationId: string,
  permission: string,
  options: { excludeUserId?: string | null; onDutyOnly?: boolean } = {},
): Promise<Recipient[]> {
  const exclude = options.excludeUserId
    ? sql`AND m.user_id <> ${options.excludeUserId}`
    : sql``;

  /**
   * On-duty filtering, used for routine traffic and NEVER for a panic.
   *
   * A dispatcher who has gone off duty does not need a notification about a
   * routine call update. A panic is different: it reaches everybody who can see
   * it, because "I had just marked myself off duty" is not a reason to miss one.
   */
  const duty = options.onDutyOnly
    ? sql`AND EXISTS (
        SELECT 1 FROM member_status ms
          JOIN operational_status os ON os.key = ms.status_key
         WHERE ms.member_id = m.id AND os.is_on_duty = true
      )`
    : sql``;

  return tx.execute<Recipient>(sql`
    SELECT m.user_id AS "userId", m.id AS "memberId"
      FROM organization_member m
      JOIN user_account u ON u.id = m.user_id
     WHERE m.organization_id = ${organizationId}
       AND m.status = 'active'
       -- A suspended or disabled account cannot sign in, so a notification for
       -- it is an unread row nobody will ever see. Their sessions were revoked
       -- when the account was disabled; this keeps the table honest too.
       AND u.status = 'active'
       ${exclude}
       ${duty}
       AND ${HOLDS_PERMISSION(permission)}
  `);
}

/**
 * The crew of one unit.
 *
 * Used for "your unit was assigned to a call". Membership of the unit is itself
 * the authorization: a person crewing a unit can see what that unit is doing, by
 * definition — there is no unit whose own crew may not know its assignment.
 */
export async function unitCrew(
  tx: Database,
  unitId: string,
  options: { excludeUserId?: string | null } = {},
): Promise<Recipient[]> {
  const exclude = options.excludeUserId
    ? sql`AND m.user_id <> ${options.excludeUserId}`
    : sql``;

  return tx.execute<Recipient>(sql`
    SELECT m.user_id AS "userId", m.id AS "memberId"
      FROM unit_member um
      JOIN organization_member m ON m.id = um.member_id
      JOIN user_account u ON u.id = m.user_id
     WHERE um.unit_id = ${unitId}
       AND um.left_at IS NULL
       AND m.status = 'active'
       AND u.status = 'active'
       ${exclude}
  `);
}

/**
 * Everybody currently crewing a unit assigned to this incident.
 *
 * The audience for "the call you are on has changed". Derived from the live
 * assignments inside the transaction, so a unit released a moment ago is not
 * told about an update to a call it has left, and a unit assigned a moment ago
 * is.
 */
export async function crewsOnIncident(
  tx: Database,
  incidentId: string,
  options: { excludeUserId?: string | null } = {},
): Promise<Recipient[]> {
  const exclude = options.excludeUserId
    ? sql`AND m.user_id <> ${options.excludeUserId}`
    : sql``;

  return tx.execute<Recipient>(sql`
    SELECT DISTINCT m.user_id AS "userId", m.id AS "memberId"
      FROM incident_assignment ia
      JOIN unit_member um ON um.unit_id = ia.unit_id AND um.left_at IS NULL
      JOIN organization_member m ON m.id = um.member_id
      JOIN user_account u ON u.id = m.user_id
     WHERE ia.incident_id = ${incidentId}
       AND ia.released_at IS NULL
       AND m.status = 'active'
       AND u.status = 'active'
       ${exclude}
  `);
}

/**
 * Dispatchers who can see an incident, across every organization involved.
 *
 * A multi-agency call has NO owning organization, so scoping to `incident.
 * organization_id` would notify nobody — the exact failure the dispatch module
 * already solves for its topics. The audience is instead every organization
 * that owns the incident or has a unit on it, and within each, the members
 * holding `dispatch.view`.
 *
 * The join to the involved organizations is what keeps this honest: a PD
 * dispatcher is told about a joint call because PD is on it, not because the
 * query forgot to filter.
 */
export async function dispatchersForIncident(
  tx: Database,
  incidentId: string,
  owningOrganizationId: string | null,
  options: { excludeUserId?: string | null; onDutyOnly?: boolean } = {},
): Promise<Recipient[]> {
  const organizationIds = new Set<string>();
  if (owningOrganizationId !== null) organizationIds.add(owningOrganizationId);

  const involved = await tx.execute<{ organization_id: string }>(sql`
    SELECT DISTINCT u.organization_id
      FROM incident_assignment a
      JOIN unit u ON u.id = a.unit_id
     WHERE a.incident_id = ${incidentId} AND a.released_at IS NULL
  `);
  for (const row of involved) organizationIds.add(row.organization_id);

  const byUser = new Map<string, Recipient>();
  for (const organizationId of organizationIds) {
    const recipients = await membersWithPermission(
      tx, organizationId, 'dispatch.view', options,
    );
    // Deduplicated by user: somebody with memberships in two of the involved
    // organizations gets one notification, not two identical ones.
    for (const recipient of recipients) byUser.set(recipient.userId, recipient);
  }
  return [...byUser.values()];
}

/** Every active member of an organization — the announcement audience. */
export async function organizationMembers(
  tx: Database,
  organizationId: string,
  options: { excludeUserId?: string | null } = {},
): Promise<Recipient[]> {
  const exclude = options.excludeUserId
    ? sql`AND m.user_id <> ${options.excludeUserId}`
    : sql``;

  return tx.execute<Recipient>(sql`
    SELECT m.user_id AS "userId", m.id AS "memberId"
      FROM organization_member m
      JOIN user_account u ON u.id = m.user_id
     WHERE m.organization_id = ${organizationId}
       AND m.status = 'active'
       AND u.status = 'active'
       ${exclude}
  `);
}

/**
 * One person, by user id.
 *
 * For notifications ABOUT somebody rather than about an event they can see —
 * "your account was suspended", "you were granted a capability". The recipient
 * is the subject, so there is no visibility question to answer.
 */
export function singleRecipient(userId: string): Recipient[] {
  return [{ userId, memberId: '' }];
}

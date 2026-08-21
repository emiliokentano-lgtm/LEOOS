import { sql } from 'drizzle-orm';
import { AUDIT_ACTIONS, type Database } from '@leoos/db';
import { can, type ActorContext } from '@leoos/authz-core';
import type { AnnouncementInput } from '@leoos/contracts';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { createNotifications, type NotificationDelivery } from './notification.service.js';
import { organizationMembers } from './recipients.js';

/**
 * Organization announcements.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONLY NOTIFICATION A HUMAN COMPOSES
 *
 * Every other notification in the system is emitted by the domain event that
 * caused it — a panic row, an assignment row, a status change. That is what
 * makes them unforgeable: there is no endpoint that writes one, so there is no
 * endpoint that writes a false one.
 *
 * This is the exception, and it is written to be a narrow one:
 *
 *   · the AUDIENCE is not chosen. It is every active member of one organization,
 *     derived here. There is no recipient parameter and no way to add one
 *     without changing this function;
 *   · the ORGANIZATION is not read from the body. It comes from the path, and
 *     the actor must hold `organization.announce` in that organization —
 *     checked against their ACTIVE organization, so a member of PD cannot
 *     announce to MD by changing an id (engineering rule 11);
 *   · the SEVERITY is capped. An announcement cannot be `critical`, because
 *     critical is the level a panic uses to earn a sticky toast and a sound, and
 *     a shift notice that can imitate a panic is a shift notice people learn to
 *     ignore panics through;
 *   · it is AUDITED. "Who put that on two hundred screens" has to be answerable.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface AnnouncementResult {
  /** How many people it actually reached. Reported honestly, including zero. */
  recipients: number;
}

export async function sendAnnouncement(
  db: Database,
  actor: ActorContext,
  organizationId: string,
  input: AnnouncementInput,
  meta: RequestMeta,
): Promise<{ result: AnnouncementResult; deliveries: NotificationDelivery[] }> {
  /**
   * Scope before permission, as everywhere else in this codebase.
   *
   * The actor's ACTIVE organization is the one the session resolved from their
   * real memberships; an id in the path that is not it is refused as not-found
   * rather than forbidden, so a caller learns nothing about organizations they
   * are not in.
   */
  if (actor.organizationId !== organizationId) throw new NotFoundError('organization');
  if (!actor.membershipActive) {
    throw new ForbiddenError('An inactive membership cannot send announcements.');
  }
  if (!can(actor, 'organization.announce')) {
    throw new ForbiddenError('You cannot send announcements.');
  }

  /**
   * `critical` is not available to a human writer.
   *
   * Not a UI decision — enforced here, where it cannot be bypassed by posting
   * directly. Critical is what a panic uses; an announcement that can dress
   * itself as one devalues the level for the alert that needs it.
   */
  const severity = input.severity === 'critical' ? 'warning' : input.severity;

  return db.transaction(async (tx) => {
    /**
     * The organization is re-read inside the transaction.
     *
     * A deleted or deactivated organization should not be able to send: the read
     * is cheap and it is the only thing standing between "this organization was
     * dissolved this morning" and two hundred notifications going out under its
     * name.
     */
    const rows = await tx.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM organization
       WHERE id = ${organizationId} AND deleted_at IS NULL AND is_active
       FOR SHARE
    `);
    const organization = rows[0];
    if (!organization) throw new NotFoundError('organization');

    const audience = await organizationMembers(
      tx, organizationId, { excludeUserId: actor.userId },
    );

    const deliveries = await createNotifications(tx, audience, {
      type: 'organization.announcement',
      title: input.title,
      body: input.body,
      severity,
      href: '/dashboard',
      entityType: 'organization',
      entityId: organizationId,
      organizationId,
      target: 'dashboard',
      metadata: { organizationName: organization.name },
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.ANNOUNCEMENT_SENT,
      actorUserId: actor.userId,
      organizationId,
      entityType: 'organization',
      entityId: organizationId,
      metadata: {
        title: input.title,
        severity,
        // The count is recorded, not the recipient list. Who is in an
        // organization is already answerable from the roster; a frozen copy of
        // it in an append-only table is a second, stale one.
        recipients: deliveries.length,
        // Recorded when the writer asked for critical and did not get it, so the
        // cap is visible in the trail rather than silently applied.
        ...(input.severity === severity ? {} : { requestedSeverity: input.severity }),
      },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return { result: { recipients: deliveries.length }, deliveries };
  });
}

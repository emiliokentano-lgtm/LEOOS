import { can, type ActorContext } from '@leoos/authz-core';

/**
 * What one caller may do in dispatch.
 *
 * Dispatch differs from the shared registers in an important way: nearly
 * everything here is ORGANIZATION-OWNED. A call belongs to a service, a unit
 * belongs to a service, and a duty status belongs to a membership. So the scope
 * carries the organization the actor is acting in, and every mutation checks the
 * resource against it BEFORE checking the permission — so a cross-organization
 * attempt audits as `CROSS_ORGANIZATION` rather than as a missing permission,
 * which is the ordering every other module here uses.
 *
 * THE ONE DELIBERATE ASYMMETRY: self-actions — setting your own status, crewing
 * a unit, raising a panic — are not gated on the dispatch management
 * permissions. An officer with no dispatch authority at all still has to be able
 * to go available, get in a car, and shout for help. What they cannot do is act
 * on anyone else, and that is where the permissions bite.
 */

export interface DispatchScope {
  canView: boolean;
  canCreateIncident: boolean;
  canManageIncident: boolean;
  canAssignUnits: boolean;
  canCloseIncident: boolean;
  /** Creating and disbanding units, and moving other people between them. */
  canManageUnits: boolean;
  canTriggerPanic: boolean;
  canAcknowledgePanic: boolean;
  /** Asking for help. A self-action: it commits the asker and nobody else. */
  canRequestBackup: boolean;
  /** Broadcasting your own position to your organization. Also a self-action. */
  canShareLocation: boolean;
  /** Sees every organization's board rather than only their own. */
  canViewAllOrganizations: boolean;

  /**
   * The organization the actor is acting in. Null when they belong to none —
   * they may hold a global capability and watch, but they cannot act.
   */
  organizationId: string | null;
  /** Organizations whose calls and units this caller may read. */
  organizationIds: string[];

  /** False for a terminated or suspended membership. */
  membershipActive: boolean;
  actorUserId: string;
}

export function resolveDispatchScope(actor: ActorContext, actorUserId: string): DispatchScope {
  const canViewAllOrganizations =
    actor.isGlobalAdmin || actor.globalCapabilities.has('org_admin');

  return {
    canView: can(actor, 'dispatch.view'),
    canCreateIncident: can(actor, 'dispatch.create'),
    canManageIncident: can(actor, 'dispatch.manage'),
    canAssignUnits: can(actor, 'dispatch.assign'),
    canCloseIncident: can(actor, 'dispatch.close'),
    canManageUnits: can(actor, 'units.manage'),
    canTriggerPanic: can(actor, 'dispatch.panic'),
    canAcknowledgePanic: can(actor, 'dispatch.panic.acknowledge'),
    canRequestBackup: can(actor, 'dispatch.request_backup'),
    canShareLocation: can(actor, 'dispatch.share_location'),
    canViewAllOrganizations,
    organizationId: actor.organizationId,
    organizationIds: actor.organizationId === null ? [] : [actor.organizationId],
    membershipActive: actor.membershipActive,
    actorUserId,
  };
}

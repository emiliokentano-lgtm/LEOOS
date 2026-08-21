import type { AccountStatus, GlobalCapabilityKey } from '@leoos/contracts';
import { ALLOW, deny, type ActorContext, type Decision } from './types.js';

/**
 * Global administration — the decisions.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PROPERTY EVERY FUNCTION HERE DEFENDS
 *
 * AN ORGANIZATION LEAD IS NOT AN ADMINISTRATOR.
 *
 * A lead is unbounded inside their own organization — they can hire, fire,
 * promote to any rank and write any organization role. None of that reaches
 * this file, and the reason is structural rather than a check somebody
 * remembered to write:
 *
 *   · every function below reads `actor.globalCapabilities`, which is populated
 *     from `user_global_role` — a table no organization operation writes to;
 *   · `can()` in decisions.ts excludes global-scope permission keys from a
 *     lead's implicit grant, so `admin.users` is not conferred by leading an
 *     organization;
 *   · `canGrantPermissions` refuses to attach a global-scope permission to an
 *     organization role, and a database trigger refuses it again.
 *
 * So there is no sequence of organization-level actions that produces a global
 * capability. A lead editing roles all day converges on "unbounded in one
 * organization" and stops there.
 *
 * The second property is about administrators locking themselves out. Two
 * operations here can make the installation unadministrable — disabling the
 * last global administrator, and revoking the last `global_admin` grant — and
 * neither is recoverable from inside the application, because the capability
 * can only be granted by somebody who already holds it. Both are refused.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Reads the actor's capability set. `global_admin` implies all of them. */
function holds(actor: ActorContext, capability: GlobalCapabilityKey): boolean {
  if (actor.isGlobalAdmin) return true;
  return actor.globalCapabilities.has(capability);
}

function requireCapability(
  actor: ActorContext,
  ...accepted: GlobalCapabilityKey[]
): Decision {
  if (accepted.some((c) => holds(actor, c))) return ALLOW;
  return deny('GLOBAL_CAPABILITY_NOT_HELD', accepted.join(' | '));
}

// ── Reading the register ───────────────────────────────────────────────────

/**
 * May the actor search accounts and read account detail?
 *
 * `support` is included and is READ-ONLY everywhere else in this file: answering
 * "is this person's account locked" is the whole job, and it needs the detail
 * read without needing the ability to change anything.
 */
export function canAdministerUsers(actor: ActorContext): Decision {
  return requireCapability(actor, 'global_admin', 'user_admin', 'support');
}

// ── Account status ─────────────────────────────────────────────────────────

/**
 * The state a status change is decided against.
 *
 * `remainingEnabledGlobalAdmins` is the count of global administrators who
 * would still be able to sign in AFTER this change — computed by the caller
 * inside the same transaction, under a lock, because it is a
 * read-decide-write race otherwise: two administrators disabling each other
 * simultaneously would each see one remaining and both succeed.
 */
export interface AccountStatusChange {
  targetUserId: string;
  targetIsGlobalAdmin: boolean;
  currentStatus: AccountStatus;
  nextStatus: AccountStatus;
  remainingEnabledGlobalAdmins: number;
}

export function canChangeAccountStatus(
  actor: ActorContext,
  change: AccountStatusChange,
): Decision {
  const base = requireCapability(actor, 'global_admin', 'user_admin');
  if (!base.allowed) return base;

  /**
   * NEVER YOUR OWN ACCOUNT.
   *
   * Not a paternalism check. An administrator who disables themselves is locked
   * out one request later with no way back in, and the failure mode is silent —
   * the request succeeds, and only the next page load reveals what happened. It
   * is also the shape a confused-deputy attack takes: persuade the one person
   * with the capability to click a button on their own row.
   */
  if (change.targetUserId === actor.userId) {
    return deny('SELF_ACTION_FORBIDDEN', 'account status');
  }

  /**
   * A `user_admin` may not touch a global administrator.
   *
   * Otherwise the lesser capability contains the greater one in the only sense
   * that matters operationally: a user administrator could disable every global
   * administrator and be the only person left who can act.
   */
  if (change.targetIsGlobalAdmin && !actor.isGlobalAdmin) {
    return deny('TARGET_IS_GLOBAL_ADMIN', change.targetUserId);
  }

  const disabling = change.nextStatus === 'suspended' || change.nextStatus === 'disabled';
  if (disabling && change.targetIsGlobalAdmin && change.remainingEnabledGlobalAdmins < 1) {
    return deny('LAST_GLOBAL_ADMIN', change.targetUserId);
  }

  return ALLOW;
}

// ── Global capabilities ────────────────────────────────────────────────────

export interface CapabilityChange {
  targetUserId: string;
  capability: GlobalCapabilityKey;
  /** Global administrators who would still hold the grant afterwards. */
  remainingGlobalAdmins: number;
}

/**
 * May the actor grant a global capability?
 *
 * GLOBAL ADMINISTRATORS ONLY, and deliberately not delegable — the same reasoning
 * as `canManageOrganizationLead`. If `user_admin` could grant capabilities, it
 * could grant itself `global_admin` and the distinction between the two would
 * last exactly one request (engineering rule 12).
 */
export function canGrantGlobalCapability(
  actor: ActorContext,
  change: CapabilityChange,
): Decision {
  if (!actor.isGlobalAdmin) {
    return deny('CAPABILITY_NOT_GRANTABLE', change.capability);
  }

  /**
   * Granting to yourself is refused even for a global administrator.
   *
   * It cannot elevate them — they already hold everything — so the only thing
   * it can do is make the audit trail read as though somebody appointed
   * themselves. Refusing keeps every capability row attributable to a decision
   * about somebody else.
   */
  if (change.targetUserId === actor.userId) {
    return deny('SELF_ACTION_FORBIDDEN', change.capability);
  }

  return ALLOW;
}

export function canRevokeGlobalCapability(
  actor: ActorContext,
  change: CapabilityChange,
): Decision {
  if (!actor.isGlobalAdmin) {
    return deny('CAPABILITY_NOT_GRANTABLE', change.capability);
  }

  /**
   * Revoking your own `global_admin` is the other way to lock everyone out, and
   * it looks reasonable at the time — "I am handing over". The handover is the
   * new administrator granting it back, which they cannot do until they have it.
   */
  if (change.targetUserId === actor.userId && change.capability === 'global_admin') {
    return deny('SELF_ACTION_FORBIDDEN', change.capability);
  }

  if (change.capability === 'global_admin' && change.remainingGlobalAdmins < 1) {
    return deny('LAST_GLOBAL_ADMIN', change.targetUserId);
  }

  return ALLOW;
}

// ── The read-only surfaces ─────────────────────────────────────────────────

/**
 * The audit log.
 *
 * `audit_viewer` exists so that reviewing the trail does not require the ability
 * to change anything — the reviewer of an incident should not need the powers
 * they are reviewing. An organization lead holds neither capability and reaches
 * none of this.
 */
export function canViewAuditLog(actor: ActorContext): Decision {
  return requireCapability(actor, 'global_admin', 'audit_viewer');
}

/**
 * Who can do what, across every organization.
 *
 * `org_admin` is included because appointing leads and editing organizations
 * without being able to see the resulting permission surface is administration
 * with the lights off.
 */
export function canViewPermissionOverview(actor: ActorContext): Decision {
  return requireCapability(actor, 'global_admin', 'org_admin', 'audit_viewer');
}

/**
 * System configuration.
 *
 * Global administrators only. It names the environment, which adapters are
 * mocked and where each setting is read from — a map of the deployment, and the
 * most useful single read for anybody trying to find a way in.
 */
export function canViewSystemConfiguration(actor: ActorContext): Decision {
  return requireCapability(actor, 'global_admin');
}

// ── The panel itself ───────────────────────────────────────────────────────

/**
 * Every admin decision at once, for the panel's navigation.
 *
 * Computed from the same functions the endpoints use, so a screen can never
 * appear for a caller whose requests would be refused, and never be hidden from
 * one whose requests would succeed.
 */
export function adminCapabilities(actor: ActorContext): {
  canAdministerUsers: boolean;
  canChangeAccountStatus: boolean;
  canGrantCapabilities: boolean;
  canAdministerOrganizations: boolean;
  canManageOrganizationLeads: boolean;
  canViewAuditLog: boolean;
  canViewPermissionOverview: boolean;
  canViewSystemConfiguration: boolean;
} {
  return {
    canAdministerUsers: canAdministerUsers(actor).allowed,
    // The status-change decision needs a target; this is the capability half of
    // it, and the per-target rules still apply at the point of use.
    canChangeAccountStatus: requireCapability(actor, 'global_admin', 'user_admin').allowed,
    canGrantCapabilities: actor.isGlobalAdmin,
    canAdministerOrganizations: requireCapability(actor, 'global_admin', 'org_admin').allowed,
    canManageOrganizationLeads: requireCapability(actor, 'global_admin', 'org_admin').allowed,
    canViewAuditLog: canViewAuditLog(actor).allowed,
    canViewPermissionOverview: canViewPermissionOverview(actor).allowed,
    canViewSystemConfiguration: canViewSystemConfiguration(actor).allowed,
  };
}

/** True when the caller may reach the administration area at all. */
export function canReachAdminPanel(actor: ActorContext): boolean {
  return Object.values(adminCapabilities(actor)).some(Boolean);
}

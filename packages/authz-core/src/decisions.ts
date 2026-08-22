import { isGlobalPermission, type PermissionKey } from '@leoos/contracts';
import {
  ALLOW, deny, MAX_HIERARCHY_LEVEL, MIN_HIERARCHY_LEVEL, NO_LEVEL, outranks,
  type ActorContext, type Decision, type RoleRef, type TargetContext,
} from './types.js';

/**
 * The authorization kernel.
 *
 * Pure functions implementing the hierarchy rules H1–H7 from
 * docs/architecture/02-authorization.md §B.3. Every management operation in the
 * system routes through these; the API wraps them with data loading and
 * transactional locking, but the rules themselves live here so they can be
 * property-tested exhaustively.
 *
 *   H1  manage(A, T)        requires level(A) >  level(T)      [strict]
 *   H2  assignRole(A, R, T) requires level(A) >  R.level
 *   H3  editRole(A, R)      requires level(A) >  R.level
 *   H4  grantPerm(A, P)     requires P ∈ effective(A)          [subset]
 *   H5  createRole(A, R)    requires level(A) >  R.level
 *   H6  A ≠ T for management actions outside the self-service allowlist
 *   H7  every check is scoped to one organization
 */

/**
 * Actions a user may always perform on themselves, given the relevant
 * permission. Everything NOT on this list is subject to H6.
 */
export const SELF_SERVICE_ACTIONS = [
  'status.set',
  'unit.join',
  'unit.leave',
  'panic.trigger',
  'account.edit_profile',
  'account.change_password',
  'account.manage_sessions',
] as const;

export type SelfServiceAction = (typeof SELF_SERVICE_ACTIONS)[number];

export function isSelfServiceAction(action: string): action is SelfServiceAction {
  return (SELF_SERVICE_ACTIONS as readonly string[]).includes(action);
}

/**
 * Does the actor hold this permission at all?
 *
 * Three sources, in order:
 *
 *   1. global admin — holds everything, including global-scope keys
 *   2. an explicit grant, from a role or an override
 *   3. the ORGANIZATION LEAD capability, which confers every
 *      organization-scoped permission inside the lead's own organization
 *
 * Source 3 is not a shortcut. A lead's nominal role is frequently a low one —
 * the capability is granted to a person, not to a rank — so reading their
 * authority off their role set alone would leave the lead of PD unable to hire
 * or fire anybody in PD. `canGrantPermissions`, `canManageMember` and
 * `canAssignRole` all already treat a lead as unbounded within their
 * organization; this makes the permission check agree with them.
 *
 * GLOBAL-SCOPE PERMISSIONS ARE EXCLUDED. `admin.users`, `admin.audit_logs`,
 * `admin.purge` and the rest are never conferred by an organization capability,
 * which is what keeps "runs one organization" from becoming "runs the system".
 *
 * The `ActorContext` is already scoped to one organization — `isOrgLead` is
 * resolved for that organization and is false everywhere else — so there is no
 * organization argument to compare here.
 */
export function can(actor: ActorContext, permission: PermissionKey): boolean {
  if (actor.isGlobalAdmin) return true;
  if (actor.permissions.has(permission)) return true;
  if (actor.isOrgLead && actor.membershipActive && !isGlobalPermission(permission)) return true;
  return false;
}

export function requirePermission(actor: ActorContext, permission: PermissionKey): Decision {
  return can(actor, permission) ? ALLOW : deny('PERMISSION_NOT_HELD', permission);
}

/**
 * H1 + H6 + H7 — may the actor manage this member at all?
 *
 * Strictly greater-than is the crux: two lieutenants at the same level are
 * mutually immune, which is the correct reading of "higher than OR EQUAL TO".
 */
export function canManageMember(actor: ActorContext, target: TargetContext): Decision {
  if (actor.isGlobalAdmin) return ALLOW;

  // H7 — authority in one organization confers nothing in another.
  if (actor.organizationId === null || actor.organizationId !== target.organizationId) {
    return deny('CROSS_ORGANIZATION');
  }
  if (!actor.membershipActive) return deny('NO_ACTIVE_MEMBERSHIP');

  // H6 — you cannot manage your own membership.
  if (actor.userId === target.userId) return deny('SELF_ACTION_FORBIDDEN');

  // A global admin is not manageable by an organization, at any rank.
  if (target.isGlobalAdmin) return deny('TARGET_IS_GLOBAL_ADMIN');

  // An organization lead is level ∞ inside their organization. Only another
  // lead or a global admin outranks them — and a peer lead does not (H1).
  if (target.isOrgLead && !actor.isOrgLead) return deny('TARGET_IS_ORG_LEAD');
  if (target.isOrgLead && actor.isOrgLead) return deny('TARGET_RANK_NOT_LOWER');

  if (actor.isOrgLead) return ALLOW;

  // H1 — strictly greater. See `outranks` for why equality is refused.
  if (!outranks(actor.level, target.level)) {
    return deny('TARGET_RANK_NOT_LOWER', `actor ${actor.level} vs target ${target.level}`);
  }
  return ALLOW;
}

/** H2 — may the actor assign this role? Blocks self-promotion via role grant. */
export function canAssignRole(actor: ActorContext, role: RoleRef): Decision {
  if (actor.isGlobalAdmin) return ALLOW;
  if (actor.organizationId === null) return deny('CROSS_ORGANIZATION');
  if (!actor.membershipActive) return deny('NO_ACTIVE_MEMBERSHIP');

  // A global role can never be handed out from inside an organization.
  if (role.organizationId === null) return deny('CROSS_ORGANIZATION', 'global role');
  if (role.organizationId !== actor.organizationId) return deny('CROSS_ORGANIZATION');

  if (actor.isOrgLead) return ALLOW;

  if (!outranks(actor.level, role.hierarchyLevel)) {
    return deny('ROLE_LEVEL_TOO_HIGH', `actor ${actor.level} vs role ${role.hierarchyLevel}`);
  }
  return ALLOW;
}

/**
 * H3 — may the actor edit this role?
 *
 * Blocks "role laundering": edit the Chief role to add your permissions, then
 * assign it to yourself.
 */
export function canEditRole(actor: ActorContext, role: RoleRef): Decision {
  if (actor.isGlobalAdmin) return ALLOW;
  if (actor.organizationId === null) return deny('CROSS_ORGANIZATION');
  if (!actor.membershipActive) return deny('NO_ACTIVE_MEMBERSHIP');
  if (role.organizationId === null) return deny('CROSS_ORGANIZATION', 'global role');
  if (role.organizationId !== actor.organizationId) return deny('CROSS_ORGANIZATION');
  if (actor.isOrgLead) return ALLOW;

  if (!outranks(actor.level, role.hierarchyLevel)) {
    return deny('ROLE_LEVEL_TOO_HIGH', `actor ${actor.level} vs role ${role.hierarchyLevel}`);
  }
  return ALLOW;
}

/** H5 — creating a role is editing one that does not exist yet. */
export function canCreateRole(actor: ActorContext, hierarchyLevel: number): Decision {
  return canEditRole(actor, {
    id: 'new',
    organizationId: actor.organizationId,
    hierarchyLevel,
  });
}

/**
 * H5b — moving an existing role to a different level.
 *
 * BOTH ENDS ARE CHECKED. Checking only the current level would let a Lieutenant
 * (L60) take the Sergeant role (L50) — which they may edit — and lift it to L90,
 * manufacturing a rank above themselves that they could then be assigned. And
 * checking only the destination would let them reach up to the Chief role and
 * drag it down, decapitating the organization. Reordering is exactly the
 * operation where a single-ended check is a hole.
 */
export function canMoveRole(
  actor: ActorContext,
  role: RoleRef,
  nextLevel: number,
): Decision {
  if (nextLevel < MIN_HIERARCHY_LEVEL || nextLevel > MAX_HIERARCHY_LEVEL) {
    return deny('LEVEL_OUT_OF_RANGE', `${nextLevel} is outside ${MIN_HIERARCHY_LEVEL}–${MAX_HIERARCHY_LEVEL}`);
  }
  const current = canEditRole(actor, role);
  if (!current.allowed) return current;
  return canCreateRole(actor, nextLevel);
}

/**
 * May the actor archive this role?
 *
 * Rank is necessary but not sufficient. A system role is structural and a
 * default role is what new hires receive — archiving either leaves the
 * organization in a state it cannot reach through the UI. Whether the role is
 * still assigned is checked against the database in the service (and by a
 * trigger), because the kernel holds no counts.
 */
export function canDeleteRole(actor: ActorContext, role: RoleRef): Decision {
  if (role.isSystem) return deny('ROLE_IS_SYSTEM', role.id);
  if (role.isDefault) return deny('ROLE_IS_DEFAULT', role.id);
  return canEditRole(actor, role);
}

/**
 * May the actor change this role's permission set?
 *
 * Two rules, and the asymmetry between them is deliberate:
 *
 *   - the role must be BELOW the actor (H3), or "edit a role you cannot reach"
 *     becomes "edit the Chief role and then get promoted into it";
 *   - every ADDED permission must be one the actor holds (H4), so authority is
 *     never bootstrapped from nothing.
 *
 * REMOVALS are not held to H4. Taking a permission away cannot raise anyone's
 * authority, and requiring the actor to hold a permission in order to remove it
 * would mean a role that drifted above its editor could never be brought back
 * down. Removal is still bounded by H3 and is audited — it is a destructive act,
 * not an escalating one.
 */
export function canChangeRolePermissions(
  actor: ActorContext,
  role: RoleRef,
  added: readonly PermissionKey[],
): Decision {
  const edit = canEditRole(actor, role);
  if (!edit.allowed) return edit;
  if (added.length === 0) return ALLOW;
  return canGrantPermissions(actor, added);
}

/**
 * H4 — the subset rule. An actor may only grant permissions they themselves
 * hold, so authority can never be bootstrapped from nothing.
 */
export function canGrantPermissions(
  actor: ActorContext,
  keys: readonly PermissionKey[],
): Decision {
  if (actor.isGlobalAdmin) return ALLOW;

  // Global-scope permissions are never grantable from an organization context —
  // this is what stops a chief writing themselves an admin role. The database
  // enforces it too (trigger role_permission_scope_check); both layers matter.
  const globalKeys = keys.filter(isGlobalPermission);
  if (globalKeys.length > 0) {
    return deny('GLOBAL_PERMISSION_ON_ORG_ROLE', globalKeys.join(', '));
  }

  if (!actor.membershipActive) return deny('NO_ACTIVE_MEMBERSHIP');

  // An organization lead holds every organization-scoped permission implicitly.
  if (actor.isOrgLead) return ALLOW;

  const missing = keys.filter((key) => !actor.permissions.has(key));
  if (missing.length > 0) {
    return deny('PERMISSION_NOT_HELD_BY_ACTOR', missing.join(', '));
  }
  return ALLOW;
}

/**
 * Combined check for a promotion or demotion: the actor must be able to manage
 * the target AND to hand out the role in question.
 */
export function canChangeMemberRole(
  actor: ActorContext,
  target: TargetContext,
  role: RoleRef,
): Decision {
  const manage = canManageMember(actor, target);
  if (!manage.allowed) return manage;
  return canAssignRole(actor, role);
}

/**
 * H8 — a per-member permission override.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE DECISION AND NOT JUST `canGrantPermissions`
 *
 * An override is the ONE place authority is handed to a person rather than to a
 * rank. Everything else in this kernel routes through a role: promote somebody
 * and they get the role's permissions; edit the role and every holder moves
 * together. That is the property engineering rules 5–8 are about, and an
 * override is a deliberate hole in it — the exception a chief writes when one
 * detective needs medical records for one investigation.
 *
 * So it carries the same ceiling as a role grant AND the rank check a role grant
 * does not need:
 *
 *   · `canManageMember` — H1 rank, H6 self, H7 scope, and the lead/global-admin
 *     immunities. Without this an officer could write themselves an override,
 *     which is the whole game.
 *   · `canGrantPermissions` — H4 subset. An actor may only hand out what they
 *     hold, so authority still cannot be bootstrapped from nothing, and a
 *     global-scope key is refused outright.
 *
 * A DENY IS NOT A GRANT, and is deliberately treated differently.
 *
 * Denying a permission REDUCES the target's authority. Requiring the actor to
 * hold a permission before they may take it away would mean a chief who does not
 * personally hold `persons.medical.view` could not stop a subordinate from using
 * it — which is backwards, and inconsistent with roles, where a removal-only
 * change is already allowed without holding the key (`canChangeRolePermissions`).
 * The rank check still applies, so a deny is never an attack on somebody senior.
 *
 * A global-scope key is refused for BOTH effects. Not because a deny would
 * escalate anything, but because an organization role cannot carry one in the
 * first place: storing a deny for a key that could never apply here would be a
 * row that reads like a control and does nothing.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function canSetPermissionOverride(
  actor: ActorContext,
  target: TargetContext,
  key: PermissionKey,
  effect: 'grant' | 'deny',
): Decision {
  const manage = canManageMember(actor, target);
  if (!manage.allowed) return manage;

  if (isGlobalPermission(key)) {
    return deny('GLOBAL_PERMISSION_ON_ORG_ROLE', key);
  }
  if (effect === 'deny') return ALLOW;
  return canGrantPermissions(actor, [key]);
}

/**
 * Clearing an override returns the member to what their ROLES say.
 *
 * Rank and scope only. The subset rule does not apply in either direction:
 * clearing a grant takes authority away, and clearing a deny restores authority
 * the member's own role already carried — in neither case is the actor handing
 * out something of their own.
 *
 * That second case deserves stating, because it is the one that looks like an
 * escalation and is not: the permission being restored was granted by a role
 * somebody with the authority to write that role already approved. Refusing it
 * here would mean a deny could be applied by a chief and then never lifted by
 * anyone who did not personally hold the key.
 */
export function canClearPermissionOverride(
  actor: ActorContext,
  target: TargetContext,
): Decision {
  return canManageMember(actor, target);
}

/**
 * Effective hierarchy level from a set of assigned roles.
 *
 * MAXIMUM, not sum: holding a junior specialist role alongside Lieutenant must
 * not dilute a lieutenant's authority, and two junior roles must never
 * manufacture a senior one.
 */
export function effectiveLevel(roleLevels: readonly number[]): number {
  if (roleLevels.length === 0) return NO_LEVEL;
  return roleLevels.reduce((max, level) => (level > max ? level : max), NO_LEVEL);
}

/**
 * Effective permission set: role grants ∪ explicit grants, minus explicit
 * denies. DENY ALWAYS WINS.
 */
export function effectivePermissions(input: {
  rolePermissions: readonly PermissionKey[];
  grants?: readonly PermissionKey[];
  denies?: readonly PermissionKey[];
}): Set<PermissionKey> {
  const set = new Set<PermissionKey>(input.rolePermissions);
  for (const key of input.grants ?? []) set.add(key);
  for (const key of input.denies ?? []) set.delete(key);
  return set;
}

// ═══════════════════════════════════════════════════════════════════════════
// Organization scope
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The organization-management decisions.
 *
 * The rule these all encode: an Organization Lead is unbounded WITHIN their own
 * organization and holds nothing anywhere else. A PD lead editing MD is not a
 * permission failure to be reported as "insufficient rank" — it is a scope
 * failure, and it must be refused before any rank comparison happens.
 *
 * The organization id passed here must always be derived from the resource being
 * acted on or from the actor's membership — NEVER read from a request body
 * (engineering rule 11). These functions cannot enforce that; the service layer
 * does, and the tests prove it.
 */

/** Only a global administrator may create or archive an organization. */
export function canCreateOrganization(actor: ActorContext): Decision {
  if (actor.isGlobalAdmin) return ALLOW;
  if (actor.globalCapabilities.has('org_admin')) return ALLOW;
  return deny('PERMISSION_NOT_HELD', 'admin.organizations');
}

export const canArchiveOrganization = canCreateOrganization;

/**
 * May the actor edit this organization's profile and settings?
 *
 * Three ways in, in order of scope:
 *   1. global admin / org_admin capability — any organization
 *   2. organization lead — their own organization only
 *   3. `organization.edit` permission — their own organization only
 */
export function canEditOrganization(
  actor: ActorContext,
  organizationId: string,
): Decision {
  if (actor.isGlobalAdmin || actor.globalCapabilities.has('org_admin')) return ALLOW;

  // Scope is checked BEFORE permission: a PD lead pointed at MD is out of
  // scope, and saying "insufficient permission" would imply the right
  // permission would work.
  if (actor.organizationId === null || actor.organizationId !== organizationId) {
    return deny('CROSS_ORGANIZATION', organizationId);
  }
  if (!actor.membershipActive) return deny('NO_ACTIVE_MEMBERSHIP');

  if (actor.isOrgLead) return ALLOW;
  if (actor.permissions.has('organization.edit')) return ALLOW;
  return deny('PERMISSION_NOT_HELD', 'organization.edit');
}

/**
 * Reading an organization's detail — same scoping, lower bar.
 *
 * `membershipActive` is checked for the SAME reason `canEditOrganization`
 * checks it, and it was once missing here. A lead grant and a membership status
 * are separate rows: firing somebody does not revoke their lead grant, so a
 * terminated chief arrived with `isOrgLead: true` and read the roster, the
 * units and the vehicles of the organization that had just fired them. The
 * context no longer asserts a lead grant on an inactive membership; this is the
 * second lock on the same door, because a read decision that trusts its input
 * is one refactor away from being wrong again.
 */
export function canViewOrganization(
  actor: ActorContext,
  organizationId: string,
): Decision {
  if (actor.isGlobalAdmin || actor.globalCapabilities.has('org_admin')) return ALLOW;
  if (actor.globalCapabilities.has('audit_viewer')) return ALLOW;

  if (actor.organizationId === null || actor.organizationId !== organizationId) {
    return deny('CROSS_ORGANIZATION', organizationId);
  }
  if (!actor.membershipActive) return deny('NO_ACTIVE_MEMBERSHIP');
  if (actor.isOrgLead) return ALLOW;
  if (actor.permissions.has('organization.view')) return ALLOW;
  return deny('PERMISSION_NOT_HELD', 'organization.view');
}

/**
 * May the actor grant or revoke the Organization Lead capability?
 *
 * GLOBAL ADMINISTRATORS ONLY — deliberately not delegable.
 *
 * An organization lead must not be able to appoint another lead, or to appoint
 * themselves elsewhere. If leads could grant the capability, the capability
 * would be self-propagating and "global admin controls who leads an
 * organization" would stop being true after the first grant. This is why the
 * capability lives in its own table rather than being a role or a permission:
 * no amount of role editing inside an organization can reach it.
 */
export function canManageOrganizationLead(actor: ActorContext): Decision {
  if (actor.isGlobalAdmin) return ALLOW;
  if (actor.globalCapabilities.has('org_admin')) return ALLOW;
  return deny('PERMISSION_NOT_HELD', 'admin.org_leads');
}

/** May the actor see who leads organizations? Global view, or own org. */
export function canViewOrganizationLeads(
  actor: ActorContext,
  organizationId: string | null,
): Decision {
  if (actor.isGlobalAdmin || actor.globalCapabilities.has('org_admin')) return ALLOW;
  if (organizationId === null) return deny('PERMISSION_NOT_HELD', 'admin.org_leads');
  return canViewOrganization(actor, organizationId);
}

/**
 * May the actor list an organization's members, roles, units or vehicles?
 *
 * The organization-admin screen aggregates all of these, and every panel is
 * scoped independently so a partial permission set yields a partial page rather
 * than an error.
 */
export function canViewOrganizationSection(
  actor: ActorContext,
  organizationId: string,
  permission: PermissionKey,
): Decision {
  if (actor.isGlobalAdmin || actor.globalCapabilities.has('org_admin')) return ALLOW;

  if (actor.organizationId === null || actor.organizationId !== organizationId) {
    return deny('CROSS_ORGANIZATION', organizationId);
  }
  // See `canViewOrganization`: a terminated member holds nothing here either,
  // lead grant or not.
  if (!actor.membershipActive) return deny('NO_ACTIVE_MEMBERSHIP');
  if (actor.isOrgLead) return ALLOW;
  if (actor.permissions.has(permission)) return ALLOW;
  return deny('PERMISSION_NOT_HELD', permission);
}

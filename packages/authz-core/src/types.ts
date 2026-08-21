import type { PermissionKey } from '@leoos/contracts';

/**
 * Authorization context types.
 *
 * These are PURE data — no database handles, no I/O. That is deliberate: the
 * decision functions in this package can then be exhaustively tested in
 * milliseconds, and the loading strategy (cached vs. locked-for-update) is a
 * concern of the caller, not of the rules.
 */

export type GlobalCapability =
  | 'global_admin' | 'user_admin' | 'org_admin' | 'audit_viewer' | 'support';

/** Level assigned to an organization lead and to a global admin. */
export const UNBOUNDED_LEVEL = Number.POSITIVE_INFINITY;

/** No roles at all, or a terminated membership. */
export const NO_LEVEL = 0;

export interface ActorContext {
  userId: string;
  /** Null when the actor is operating outside any organization context. */
  organizationId: string | null;
  isGlobalAdmin: boolean;
  /** Lead OF THE ACTIVE ORGANIZATION only. Never implies anything elsewhere. */
  isOrgLead: boolean;
  /** Effective hierarchy level in the active organization. */
  level: number;
  permissions: ReadonlySet<PermissionKey>;
  globalCapabilities: ReadonlySet<GlobalCapability>;
  /** Terminated / suspended members can manage nobody. */
  membershipActive: boolean;
}

export interface TargetContext {
  userId: string;
  organizationId: string;
  level: number;
  isOrgLead: boolean;
  isGlobalAdmin: boolean;
}

export interface RoleRef {
  id: string;
  organizationId: string | null;
  hierarchyLevel: number;
  /** Seeded structural roles. Renaming or archiving one is refused outright. */
  isSystem?: boolean;
  /** The role new hires receive. An organization must always have exactly one. */
  isDefault?: boolean;
}

/**
 * The hierarchy scale.
 *
 * 1–100, HIGHER MEANS MORE SENIOR (ADR-0007), matched by a database CHECK
 * constraint. Seeded structures leave gaps (10, 20, 30…) so a rank can be
 * inserted between two others without renumbering the whole organization.
 */
export const MIN_HIERARCHY_LEVEL = 1;
export const MAX_HIERARCHY_LEVEL = 100;

/**
 * THE RANK COMPARISON POLICY, in one place.
 *
 * Authority requires a STRICTLY higher level. Equal ranks are mutually immune:
 * two Commanders cannot manage, promote, demote or fire each other, and neither
 * can raise anyone to their own level.
 *
 * The alternative — allowing action at equal rank — is what makes peer coups
 * possible, and it has no safe reading: if a Commander may promote someone to
 * Commander, the organization can be flooded with peers by a single actor. The
 * comparison lives here rather than being spelled out at each call site so the
 * policy is auditable in one read and cannot drift between decisions.
 */
export function outranks(actorLevel: number, otherLevel: number): boolean {
  return actorLevel > otherLevel;
}

export type DenyReason =
  | 'PERMISSION_NOT_HELD'
  | 'TARGET_RANK_NOT_LOWER'
  | 'ROLE_LEVEL_TOO_HIGH'
  | 'PERMISSION_NOT_HELD_BY_ACTOR'
  | 'CROSS_ORGANIZATION'
  | 'SELF_ACTION_FORBIDDEN'
  | 'NO_ACTIVE_MEMBERSHIP'
  | 'TARGET_IS_ORG_LEAD'
  | 'TARGET_IS_GLOBAL_ADMIN'
  | 'GLOBAL_PERMISSION_ON_ORG_ROLE'
  | 'ROLE_IS_SYSTEM'
  | 'ROLE_IN_USE'
  | 'ROLE_IS_DEFAULT'
  | 'LEVEL_OUT_OF_RANGE'
  /**
   * The action would leave the installation with no way in.
   *
   * Disabling the last global administrator, or revoking the last
   * `global_admin` grant, locks everyone out of administration permanently —
   * there is no other path back, because the capability can only be granted by
   * somebody who already holds it.
   */
  | 'LAST_GLOBAL_ADMIN'
  /** Only a global administrator may confer `global_admin`. */
  | 'CAPABILITY_NOT_GRANTABLE'
  /** The action needs a global capability the actor does not hold. */
  | 'GLOBAL_CAPABILITY_NOT_HELD';

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: DenyReason; detail?: string };

export const ALLOW: Decision = { allowed: true };

export function deny(reason: DenyReason, detail?: string): Decision {
  return detail === undefined ? { allowed: false, reason } : { allowed: false, reason, detail };
}

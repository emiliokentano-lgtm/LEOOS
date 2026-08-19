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
  | 'GLOBAL_PERMISSION_ON_ORG_ROLE';

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: DenyReason; detail?: string };

export const ALLOW: Decision = { allowed: true };

export function deny(reason: DenyReason, detail?: string): Decision {
  return detail === undefined ? { allowed: false, reason } : { allowed: false, reason, detail };
}

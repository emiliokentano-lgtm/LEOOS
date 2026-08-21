import { PERMISSION_KEYS, permissionMeta, type PermissionKey } from './permissions';
import type { OrganizationSummary } from './organizations';

/**
 * Global administration contracts.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE PROPERTY THIS FILE EXISTS TO GUARANTEE
 *
 * The administration surface reads the most sensitive table in the system. The
 * `user_account` row it is built from carries `password_hash`, `totp_secret_enc`
 * and the login-failure counters, and a DTO assembled by spreading that row
 * would leak all three the day somebody adds a column.
 *
 * So none of the types below has anywhere to put a credential. `AdminUserDetail`
 * names its fields one by one, there is no index signature, and a test asserts
 * that no serialised admin response contains `passwordHash`, `password_hash`,
 * `tokenHash`, `secretHash` or `totpSecret` (engineering rule 16).
 * ────────────────────────────────────────────────────────────────────────────
 *
 * SECOND PROPERTY: an Organization Lead is not an administrator. Everything here
 * is reachable only with a global capability, which lives in its own table and
 * cannot be conferred by editing an organization role. The types carry a
 * `capabilities` block so the UI can hide what the caller cannot do — cosmetic
 * only; the API re-decides every operation server-side (engineering rule 9).
 */

// ── Global capabilities ────────────────────────────────────────────────────

/**
 * The five global capabilities, as data.
 *
 * `global_admin` is deliberately separate from the rest rather than being
 * "user_admin plus more": it is the only one that can confer itself, and
 * treating it as a superset would make that special case invisible.
 */
export type GlobalCapabilityKey =
  | 'global_admin' | 'user_admin' | 'org_admin' | 'audit_viewer' | 'support';

export interface GlobalCapabilityMeta {
  readonly key: GlobalCapabilityKey;
  readonly label: string;
  readonly description: string;
  /**
   * Whether holding this capability lets its holder GRANT capabilities.
   *
   * Only `global_admin` does, and only a `global_admin` may confer
   * `global_admin`. A `user_admin` who could grant it would be one request away
   * from being an administrator, which is the escalation engineering rule 12
   * exists to prevent.
   */
  readonly canGrantCapabilities: boolean;
}

export const GLOBAL_CAPABILITIES: Record<GlobalCapabilityKey, GlobalCapabilityMeta> = {
  global_admin: {
    key: 'global_admin',
    label: 'Global administrator',
    description:
      'Unrestricted. Administers every account, organization and capability, '
      + 'and is the only capability that can grant capabilities.',
    canGrantCapabilities: true,
  },
  user_admin: {
    key: 'user_admin',
    label: 'User administrator',
    description:
      'Searches accounts, reads account detail and changes account status. '
      + 'Cannot grant capabilities and cannot administer organizations.',
    canGrantCapabilities: false,
  },
  org_admin: {
    key: 'org_admin',
    label: 'Organization administrator',
    description:
      'Creates, edits and archives organizations, and appoints Organization '
      + 'Leads. Holds nothing over accounts.',
    canGrantCapabilities: false,
  },
  audit_viewer: {
    key: 'audit_viewer',
    label: 'Audit viewer',
    description:
      'Reads the audit log across every organization. Read-only: this '
      + 'capability changes nothing anywhere.',
    canGrantCapabilities: false,
  },
  support: {
    key: 'support',
    label: 'Support',
    description:
      'Reads account detail to answer support requests. Changes nothing.',
    canGrantCapabilities: false,
  },
};

export const GLOBAL_CAPABILITY_KEYS = Object.keys(GLOBAL_CAPABILITIES) as GlobalCapabilityKey[];

// ── Account status ─────────────────────────────────────────────────────────

/**
 * The four account states, and what each one means to the person holding it.
 *
 * `suspended` and `disabled` both stop a sign-in, and keeping them apart is the
 * point: suspension is a temporary measure taken during an investigation, and
 * disabling is the end of an account's working life. An administrator reviewing
 * the register a month later needs to be able to tell which decision was made.
 */
export type AccountStatus = 'pending_verification' | 'active' | 'suspended' | 'disabled';

export interface AccountStatusMeta {
  readonly key: AccountStatus;
  readonly label: string;
  readonly description: string;
  /** Whether an account in this state can sign in. */
  readonly canSignIn: boolean;
  readonly tone: 'success' | 'warning' | 'danger' | 'neutral';
}

export const ACCOUNT_STATUSES: Record<AccountStatus, AccountStatusMeta> = {
  pending_verification: {
    key: 'pending_verification',
    label: 'Pending verification',
    description: 'Registered but has not verified their email address yet.',
    canSignIn: false,
    tone: 'neutral',
  },
  active: {
    key: 'active',
    label: 'Active',
    description: 'Can sign in and hold memberships.',
    canSignIn: true,
    tone: 'success',
  },
  suspended: {
    key: 'suspended',
    label: 'Suspended',
    description: 'Temporarily barred from signing in. Sessions were revoked.',
    canSignIn: false,
    tone: 'warning',
  },
  disabled: {
    key: 'disabled',
    label: 'Disabled',
    description: 'Deactivated. Sessions were revoked and memberships are preserved.',
    canSignIn: false,
    tone: 'danger',
  },
};

/**
 * The statuses an administrator may set directly.
 *
 * `pending_verification` is absent on purpose: it is a state the registration
 * flow produces, and letting an administrator push an account back into it
 * would invent a verification that never expired. Re-verifying is its own flow.
 */
export const SETTABLE_ACCOUNT_STATUSES: AccountStatus[] = ['active', 'suspended', 'disabled'];

// ── Users ──────────────────────────────────────────────────────────────────

export interface AdminMembershipSummary {
  memberId: string;
  organization: OrganizationSummary;
  status: string;
  callsign: string | null;
  employeeNumber: string | null;
  roles: { id: string; key: string; name: string; hierarchyLevel: number }[];
  hierarchyLevel: number;
  isOrgLead: boolean;
  joinedAt: string;
  leftAt: string | null;
}

/**
 * One row in the user register.
 *
 * Carries what the list actually shows and nothing more. The detail read is a
 * separate request precisely so that a search across the whole register does not
 * ship everyone's memberships to the browser.
 */
export interface AdminUserSummary {
  id: string;
  username: string;
  email: string;
  displayName: string;
  status: AccountStatus;
  emailVerified: boolean;
  globalCapabilities: GlobalCapabilityKey[];
  /** Count only — the names are in the detail read. */
  membershipCount: number;
  organizationShortNames: string[];
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminUserDetail {
  id: string;
  username: string;
  email: string;
  displayName: string;
  status: AccountStatus;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
  globalCapabilities: { key: GlobalCapabilityKey; grantedAt: string; grantedByName: string | null }[];
  memberships: AdminMembershipSummary[];
  lastLoginAt: string | null;
  /**
   * The address of the last successful sign-in.
   *
   * Present because "was that them?" is the first question asked about a
   * compromised account, and absent from the LIST for the same reason it is
   * present here: it is personal data, and a register-wide search has no need
   * of it.
   */
  lastLoginIp: string | null;
  /** Live sessions. A count, not a list of tokens. */
  activeSessionCount: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Set when the account is locked out by failed sign-ins.
   *
   * The COUNT is deliberately not exposed: it tells an administrator nothing
   * they can act on, and it is a nudge towards treating a number of failures as
   * evidence of something. Whether the account is currently locked is the
   * actionable fact.
   */
  lockedUntil: string | null;
  /** What the CALLER may do to this account. Cosmetic; re-decided server-side. */
  capabilities: AdminUserCapabilities;
}

export interface AdminUserCapabilities {
  canChangeStatus: boolean;
  canGrantCapabilities: boolean;
  /**
   * Why an action is unavailable, when the reason is a policy rather than a
   * missing permission — "you cannot change your own account status". Shown to
   * the administrator instead of a silently disabled control.
   */
  restrictions: string[];
}

export interface AdminUserQuery {
  /** Matches username, email or display name. */
  search?: string;
  status?: AccountStatus;
  capability?: GlobalCapabilityKey;
  organizationId?: string;
  /** Accounts with no membership anywhere — the queue after registration. */
  unaffiliated?: boolean;
  limit?: number;
  offset?: number;
}

export interface AdminUserList {
  users: AdminUserSummary[];
  total: number;
  limit: number;
  offset: number;
}

// ── Organization leads ─────────────────────────────────────────────────────

export interface AdminLeadEntry {
  userId: string;
  username: string;
  displayName: string;
  accountStatus: AccountStatus;
  organization: OrganizationSummary;
  /** The membership the lead grant rests on. A lead must be a member. */
  membershipStatus: string;
  callsign: string | null;
  grantedAt: string;
  grantedByName: string | null;
}

export interface AdminLeadOverview {
  leads: AdminLeadEntry[];
  /** Organizations with nobody leading them — the actionable half of this screen. */
  organizationsWithoutLead: OrganizationSummary[];
  canManage: boolean;
}

// ── Permission overview ────────────────────────────────────────────────────

/**
 * Where a permission is actually in force.
 *
 * The catalogue alone answers "what permissions exist", which nobody asks. The
 * question an administrator has is "who can terminate members right now", and
 * that is a join across roles and organizations — so the overview reports, for
 * every permission, the roles that grant it and how many people hold those
 * roles.
 */
export interface PermissionRoleGrant {
  roleId: string;
  roleName: string;
  roleKey: string;
  hierarchyLevel: number;
  organization: OrganizationSummary | null;
  memberCount: number;
}

export interface PermissionOverviewEntry {
  key: PermissionKey;
  label: string;
  category: string;
  risk: 'low' | 'medium' | 'high';
  scope: 'organization' | 'global';
  grants: PermissionRoleGrant[];
  /** Members holding it through a per-member override rather than a role. */
  overrideGrantCount: number;
  overrideDenyCount: number;
}

export interface PermissionOverview {
  entries: PermissionOverviewEntry[];
  organizations: OrganizationSummary[];
  /**
   * Global-scope permissions, called out separately.
   *
   * They can never be attached to an ORGANIZATION role — the kernel refuses it
   * and a database trigger refuses it again. They CAN belong to a global role
   * (one with no organization), which is how a platform-administrator role is
   * built, so an entry here may well have grants; what it will never have is a
   * grant carrying an organization. The screen says so, because "no grants"
   * and "grants that are deliberately organization-less" look identical
   * otherwise.
   */
  globalPermissionKeys: PermissionKey[];
}

export function permissionOverviewSkeleton(): Omit<PermissionOverviewEntry, 'grants'>[] {
  return PERMISSION_KEYS.map((key) => {
    const meta = permissionMeta(key);
    return {
      key,
      label: meta.label,
      category: meta.category,
      risk: meta.risk,
      scope: meta.scope ?? 'organization',
      overrideGrantCount: 0,
      overrideDenyCount: 0,
    };
  });
}

// ── Audit ──────────────────────────────────────────────────────────────────

export type AuditOutcome = 'success' | 'denied' | 'error';

/**
 * Severity, DERIVED — not a stored column.
 *
 * The audit table has no severity field, and adding one would mean back-filling
 * every existing row with a guess about what it should have been. Severity is
 * instead computed from two things the row does carry: what the action is, and
 * whether it succeeded.
 *
 *   critical  a refused privileged action, or a purge — somebody tried
 *             something they were not allowed to do
 *   high      a privilege or account change that succeeded
 *   notice    an ordinary operational change
 *   info      a read, a sign-in, routine traffic
 *
 * Stating this as a derivation rather than a column keeps the log honest: the
 * severity of a row can be recomputed from the row, so it cannot drift from what
 * actually happened (engineering rule 34).
 */
export type AuditSeverity = 'critical' | 'high' | 'notice' | 'info';

export const AUDIT_SEVERITIES: Record<AuditSeverity, {
  label: string;
  description: string;
  tone: 'danger' | 'warning' | 'info' | 'neutral';
}> = {
  critical: {
    label: 'Critical',
    description: 'A refused privileged action, or an irreversible erasure.',
    tone: 'danger',
  },
  high: {
    label: 'High',
    description: 'A successful change to privileges, accounts or organizations.',
    tone: 'warning',
  },
  notice: {
    label: 'Notice',
    description: 'An ordinary operational change.',
    tone: 'info',
  },
  info: {
    label: 'Info',
    description: 'A read, a sign-in, or routine traffic.',
    tone: 'neutral',
  },
};

/**
 * The action prefixes that count as PRIVILEGED.
 *
 * Prefix matching rather than an enumerated list, so a new action added under
 * one of these namespaces is classified correctly the day it ships instead of
 * silently landing in `info` until somebody remembers this file.
 */
const PRIVILEGED_ACTION_PREFIXES = [
  'user.', 'organization.', 'role.', 'permission.', 'admin.', 'game_server.',
];

/** Actions that are reads or routine traffic even though they succeed. */
const INFO_ACTIONS = new Set([
  'auth.login', 'auth.logout', 'person.viewed', 'vehicle.viewed',
  'search.performed', 'map.history_viewed', 'person.medical_viewed',
]);

export function auditSeverityOf(action: string, outcome: AuditOutcome): AuditSeverity {
  const privileged = PRIVILEGED_ACTION_PREFIXES.some((p) => action.startsWith(p));

  // A refusal is the interesting row. Someone attempting a privileged action
  // they do not hold is the signal an operations lead is actually scanning for,
  // so it outranks the same action succeeding.
  if (outcome === 'denied') return privileged ? 'critical' : 'high';
  if (outcome === 'error') return 'high';

  // A purge that SUCCEEDED. One that failed is covered by the line above — it
  // erased nothing, so it is not the irreversible event this level is for.
  if (action === 'admin.record_purged') return 'critical';
  if (privileged) return 'high';
  if (INFO_ACTIONS.has(action)) return 'info';
  return 'notice';
}

export interface AuditActorRef {
  type: 'user' | 'system' | 'game_server' | 'job';
  userId: string | null;
  /** Denormalised at write time, so the trail survives account deletion. */
  label: string | null;
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  actor: AuditActorRef;
  action: string;
  outcome: AuditOutcome;
  severity: AuditSeverity;
  entityType: string | null;
  entityId: string | null;
  /** Resolved display name for the target, when one could be found. */
  entityLabel: string | null;
  organization: OrganizationSummary | null;
  /**
   * Contextual information, as stored.
   *
   * Passed through rather than rendered into a sentence: the metadata of a role
   * change and of a panic have nothing in common, and a formatter that tried to
   * summarise both would end up lying about one of them.
   */
  metadata: Record<string, unknown>;
  ip: string | null;
  requestId: string | null;
}

export interface AuditQuery {
  /** Free text over action, actor label and entity label. */
  search?: string;
  actorUserId?: string;
  action?: string;
  /** Prefix, so `role.` selects the whole namespace. */
  actionPrefix?: string;
  organizationId?: string;
  entityType?: string;
  entityId?: string;
  outcome?: AuditOutcome;
  severity?: AuditSeverity;
  from?: string;
  to?: string;
  limit?: number;
  /**
   * Keyset cursor — the `occurredAt|id` of the last row seen.
   *
   * Not an offset. The audit log is append-only and constantly growing, so an
   * offset walks backwards through a list that has shifted underneath it and
   * duplicates or skips rows. A keyset does not.
   */
  cursor?: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Null when this is the last page. */
  nextCursor: string | null;
  /**
   * Whether the count is exact.
   *
   * An exact count over a table that only grows is an expensive scan for a
   * number that is stale by the time it renders. Beyond a threshold the API
   * reports the bound it actually checked rather than a figure it did not.
   */
  approximateTotal: number;
  totalIsExact: boolean;
}

/** The audit action namespaces, for the filter bar. Data, not a switch. */
export const AUDIT_ACTION_NAMESPACES: { prefix: string; label: string }[] = [
  { prefix: 'auth.', label: 'Authentication' },
  { prefix: 'user.', label: 'Accounts' },
  { prefix: 'organization.', label: 'Organizations' },
  { prefix: 'role.', label: 'Roles' },
  { prefix: 'permission.', label: 'Permissions' },
  { prefix: 'personnel.', label: 'Personnel' },
  { prefix: 'person.', label: 'Person records' },
  { prefix: 'vehicle.', label: 'Vehicles' },
  { prefix: 'warrant.', label: 'Warrants' },
  { prefix: 'incident.', label: 'Incidents' },
  { prefix: 'unit.', label: 'Units' },
  { prefix: 'panic.', label: 'Panic' },
  { prefix: 'status.', label: 'Status changes' },
  { prefix: 'map.', label: 'Map' },
  { prefix: 'game_server.', label: 'Game servers' },
  { prefix: 'game_identity.', label: 'Game identities' },
  { prefix: 'search.', label: 'Search' },
  { prefix: 'admin.', label: 'Administration' },
];

// ── System configuration ───────────────────────────────────────────────────

/**
 * What the system is actually running.
 *
 * Every entry reports the state it HAS, never a green light it has not earned
 * (engineering rules 35, 45). An adapter behind a mock says so in the same words
 * the boot log uses, and the screen is read-only: this reports configuration, it
 * does not offer to change it. Editing a deployment's configuration from inside
 * the application it configures is a bootstrapping problem, not a feature.
 */
export interface SystemComponent {
  key: string;
  label: string;
  /**
   * `live` — connected and working.
   * `mock` — a clearly named placeholder adapter is registered.
   * `absent` — not configured; the feature that needs it is unavailable.
   * `degraded` — configured, but not currently healthy.
   */
  state: 'live' | 'mock' | 'absent' | 'degraded';
  detail: string;
  /** Where the setting lives, so an operator knows what to change. */
  source: string | null;
}

export interface SystemStatus {
  environment: string;
  /** Whether mock adapters are permitted in this process. */
  mockAdaptersAllowed: boolean;
  components: SystemComponent[];
  /** Counts that describe the installation's size, not its activity. */
  scale: {
    users: number;
    activeUsers: number;
    organizations: number;
    auditEntries: number;
  };
}

// ── The panel's own capability block ───────────────────────────────────────

/**
 * What the caller may reach, decided once by the API.
 *
 * The panel's navigation is built from this rather than from the session's
 * capability list, so the set of screens and the set of endpoints cannot drift
 * apart: both come from the same server-side decisions.
 */
export interface AdminCapabilities {
  canAdministerUsers: boolean;
  canChangeAccountStatus: boolean;
  canGrantCapabilities: boolean;
  canAdministerOrganizations: boolean;
  canManageOrganizationLeads: boolean;
  canViewAuditLog: boolean;
  canViewPermissionOverview: boolean;
  canViewSystemConfiguration: boolean;
}

/** True when the caller may reach the panel at all. */
export function hasAnyAdminCapability(capabilities: AdminCapabilities): boolean {
  return Object.values(capabilities).some(Boolean);
}

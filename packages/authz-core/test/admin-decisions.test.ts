import { describe, expect, it } from 'vitest';
import { PERMISSION_KEYS, isGlobalPermission, type PermissionKey } from '@leoos/contracts';
import {
  UNBOUNDED_LEVEL,
  adminCapabilities, can, canAdministerUsers, canChangeAccountStatus, canGrantPermissions,
  canGrantGlobalCapability, canReachAdminPanel, canRevokeGlobalCapability, canViewAuditLog,
  canViewPermissionOverview, canViewSystemConfiguration,
  type AccountStatusChange, type ActorContext, type CapabilityChange,
} from '../src/index.js';

const ORG = 'org-pd';

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    userId: 'actor',
    organizationId: ORG,
    isGlobalAdmin: false,
    isOrgLead: false,
    level: 50,
    permissions: new Set<PermissionKey>(),
    globalCapabilities: new Set(),
    membershipActive: true,
    ...overrides,
  };
}

/** The account the user asked us to be certain about: an Organization Lead. */
function orgLead(): ActorContext {
  return actor({ isOrgLead: true, level: UNBOUNDED_LEVEL });
}

function globalAdmin(): ActorContext {
  return actor({ userId: 'admin', isGlobalAdmin: true, organizationId: null, level: UNBOUNDED_LEVEL });
}

function statusChange(overrides: Partial<AccountStatusChange> = {}): AccountStatusChange {
  return {
    targetUserId: 'target',
    targetIsGlobalAdmin: false,
    currentStatus: 'active',
    nextStatus: 'disabled',
    remainingEnabledGlobalAdmins: 3,
    ...overrides,
  };
}

function capabilityChange(overrides: Partial<CapabilityChange> = {}): CapabilityChange {
  return {
    targetUserId: 'target',
    capability: 'user_admin',
    remainingGlobalAdmins: 3,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// The headline property.
// ═══════════════════════════════════════════════════════════════════════════

describe('an Organization Lead reaches no global administration', () => {
  const lead = orgLead();

  it('cannot administer users', () => {
    expect(canAdministerUsers(lead).allowed).toBe(false);
  });

  it('cannot change an account status', () => {
    expect(canChangeAccountStatus(lead, statusChange()).allowed).toBe(false);
  });

  it('cannot grant or revoke a global capability', () => {
    expect(canGrantGlobalCapability(lead, capabilityChange()).allowed).toBe(false);
    expect(canRevokeGlobalCapability(lead, capabilityChange()).allowed).toBe(false);
  });

  it('cannot read the audit log, the permission overview or the configuration', () => {
    expect(canViewAuditLog(lead).allowed).toBe(false);
    expect(canViewPermissionOverview(lead).allowed).toBe(false);
    expect(canViewSystemConfiguration(lead).allowed).toBe(false);
  });

  it('cannot reach the panel at all', () => {
    expect(canReachAdminPanel(lead)).toBe(false);
    expect(Object.values(adminCapabilities(lead)).every((v) => v === false)).toBe(true);
  });

  it('holds no global-scope permission, however senior they are in their own org', () => {
    // The lead's implicit grant covers organization-scoped keys only. This is
    // the mechanism the four assertions above rest on, so it is asserted over
    // the WHOLE catalogue rather than on a couple of examples.
    const globalKeys = PERMISSION_KEYS.filter(isGlobalPermission);
    expect(globalKeys.length).toBeGreaterThan(0);
    for (const key of globalKeys) {
      expect(can(lead, key)).toBe(false);
    }
  });

  it('cannot write a role that would grant itself global permissions', () => {
    // The other half of the same property: if a lead could attach `admin.users`
    // to a role, the exclusion above would be a formality.
    const globalKeys = PERMISSION_KEYS.filter(isGlobalPermission);
    expect(canGrantPermissions(lead, globalKeys).allowed).toBe(false);
    expect(canGrantPermissions(lead, ['personnel.hire']).allowed).toBe(true);
  });

  it('stays powerless even holding every organization-scoped permission', () => {
    const everyOrgKey = PERMISSION_KEYS.filter((k) => !isGlobalPermission(k));
    const maximal = actor({
      isOrgLead: true,
      level: UNBOUNDED_LEVEL,
      permissions: new Set(everyOrgKey),
    });
    expect(canReachAdminPanel(maximal)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Capability gating
// ═══════════════════════════════════════════════════════════════════════════

describe('reading the register', () => {
  it('is open to global_admin, user_admin and support', () => {
    for (const capability of ['user_admin', 'support'] as const) {
      expect(canAdministerUsers(actor({ globalCapabilities: new Set([capability]) })).allowed)
        .toBe(true);
    }
    expect(canAdministerUsers(globalAdmin()).allowed).toBe(true);
  });

  it('is closed to org_admin and audit_viewer', () => {
    // Administering organizations is not administering the people in them.
    expect(canAdministerUsers(actor({ globalCapabilities: new Set(['org_admin']) })).allowed)
      .toBe(false);
    expect(canAdministerUsers(actor({ globalCapabilities: new Set(['audit_viewer']) })).allowed)
      .toBe(false);
  });

  it('is closed to an ordinary member', () => {
    expect(canAdministerUsers(actor()).allowed).toBe(false);
  });
});

describe('support is read-only', () => {
  const support = actor({ globalCapabilities: new Set(['support']) });

  it('reads account detail', () => {
    expect(canAdministerUsers(support).allowed).toBe(true);
  });

  it('changes nothing', () => {
    expect(canChangeAccountStatus(support, statusChange()).allowed).toBe(false);
    expect(canGrantGlobalCapability(support, capabilityChange()).allowed).toBe(false);
    expect(adminCapabilities(support).canChangeAccountStatus).toBe(false);
    expect(adminCapabilities(support).canGrantCapabilities).toBe(false);
  });
});

describe('audit_viewer reads the trail and nothing else', () => {
  const viewer = actor({ globalCapabilities: new Set(['audit_viewer']) });

  it('reads the audit log and the permission overview', () => {
    expect(canViewAuditLog(viewer).allowed).toBe(true);
    expect(canViewPermissionOverview(viewer).allowed).toBe(true);
  });

  it('cannot read the system configuration', () => {
    expect(canViewSystemConfiguration(viewer).allowed).toBe(false);
  });

  it('cannot change anything', () => {
    expect(canChangeAccountStatus(viewer, statusChange()).allowed).toBe(false);
    expect(canGrantGlobalCapability(viewer, capabilityChange()).allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Account status
// ═══════════════════════════════════════════════════════════════════════════

describe('account status changes', () => {
  it('lets a user administrator disable an ordinary account', () => {
    const admin = actor({ globalCapabilities: new Set(['user_admin']) });
    expect(canChangeAccountStatus(admin, statusChange()).allowed).toBe(true);
  });

  it('refuses a change to the actor’s OWN account', () => {
    const admin = globalAdmin();
    const decision = canChangeAccountStatus(
      admin, statusChange({ targetUserId: admin.userId }),
    );
    expect(decision).toMatchObject({ allowed: false, reason: 'SELF_ACTION_FORBIDDEN' });
  });

  it('refuses self-reactivation too, not only self-disabling', () => {
    // The rule is about the actor and the target being the same person, not
    // about the direction of the change.
    const admin = globalAdmin();
    expect(canChangeAccountStatus(admin, statusChange({
      targetUserId: admin.userId, currentStatus: 'suspended', nextStatus: 'active',
    })).allowed).toBe(false);
  });

  it('refuses a user administrator touching a global administrator', () => {
    const admin = actor({ globalCapabilities: new Set(['user_admin']) });
    const decision = canChangeAccountStatus(admin, statusChange({ targetIsGlobalAdmin: true }));
    expect(decision).toMatchObject({ allowed: false, reason: 'TARGET_IS_GLOBAL_ADMIN' });
  });

  it('lets a global administrator disable another global administrator', () => {
    expect(canChangeAccountStatus(globalAdmin(), statusChange({
      targetIsGlobalAdmin: true, remainingEnabledGlobalAdmins: 1,
    })).allowed).toBe(true);
  });

  it('refuses disabling the LAST global administrator', () => {
    const decision = canChangeAccountStatus(globalAdmin(), statusChange({
      targetIsGlobalAdmin: true,
      nextStatus: 'disabled',
      remainingEnabledGlobalAdmins: 0,
    }));
    expect(decision).toMatchObject({ allowed: false, reason: 'LAST_GLOBAL_ADMIN' });
  });

  it('refuses SUSPENDING the last global administrator as well', () => {
    // Suspension bars sign-in exactly as disabling does; only the intent
    // differs. Guarding one and not the other would leave the lockout reachable
    // through the gentler-sounding button.
    expect(canChangeAccountStatus(globalAdmin(), statusChange({
      targetIsGlobalAdmin: true,
      nextStatus: 'suspended',
      remainingEnabledGlobalAdmins: 0,
    })).allowed).toBe(false);
  });

  it('allows REINSTATING a global administrator regardless of the count', () => {
    // The count guard is about removing the last way in, so it must not block
    // the operation that adds one back.
    expect(canChangeAccountStatus(globalAdmin(), statusChange({
      targetIsGlobalAdmin: true,
      currentStatus: 'disabled',
      nextStatus: 'active',
      remainingEnabledGlobalAdmins: 0,
    })).allowed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Global capabilities
// ═══════════════════════════════════════════════════════════════════════════

describe('granting global capabilities', () => {
  it('is reserved to global administrators', () => {
    expect(canGrantGlobalCapability(globalAdmin(), capabilityChange()).allowed).toBe(true);
    for (const capability of ['user_admin', 'org_admin', 'audit_viewer', 'support'] as const) {
      const holder = actor({ globalCapabilities: new Set([capability]) });
      expect(canGrantGlobalCapability(holder, capabilityChange()).allowed).toBe(false);
    }
  });

  it('refuses a user administrator granting itself global_admin', () => {
    // The escalation this whole design exists to prevent: one request from
    // "manages accounts" to "manages everything".
    const admin = actor({ userId: 'ua', globalCapabilities: new Set(['user_admin']) });
    const decision = canGrantGlobalCapability(admin, capabilityChange({
      targetUserId: 'ua', capability: 'global_admin',
    }));
    expect(decision).toMatchObject({ allowed: false, reason: 'CAPABILITY_NOT_GRANTABLE' });
  });

  it('refuses a global administrator granting to themselves', () => {
    const admin = globalAdmin();
    expect(canGrantGlobalCapability(admin, capabilityChange({
      targetUserId: admin.userId,
    })).allowed).toBe(false);
  });
});

describe('revoking global capabilities', () => {
  it('refuses revoking your own global_admin', () => {
    const admin = globalAdmin();
    const decision = canRevokeGlobalCapability(admin, capabilityChange({
      targetUserId: admin.userId, capability: 'global_admin', remainingGlobalAdmins: 5,
    }));
    expect(decision).toMatchObject({ allowed: false, reason: 'SELF_ACTION_FORBIDDEN' });
  });

  it('allows revoking your own LESSER capability', () => {
    // Standing down from `audit_viewer` is not a lockout; nothing depends on
    // holding it to grant it back.
    const admin = globalAdmin();
    expect(canRevokeGlobalCapability(admin, capabilityChange({
      targetUserId: admin.userId, capability: 'audit_viewer',
    })).allowed).toBe(true);
  });

  it('refuses revoking the last global_admin grant', () => {
    const decision = canRevokeGlobalCapability(globalAdmin(), capabilityChange({
      capability: 'global_admin', remainingGlobalAdmins: 0,
    }));
    expect(decision).toMatchObject({ allowed: false, reason: 'LAST_GLOBAL_ADMIN' });
  });

  it('allows revoking a lesser capability from the last global administrator', () => {
    expect(canRevokeGlobalCapability(globalAdmin(), capabilityChange({
      capability: 'support', remainingGlobalAdmins: 0,
    })).allowed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The capability block the UI is built from
// ═══════════════════════════════════════════════════════════════════════════

describe('adminCapabilities agrees with the individual decisions', () => {
  const cases: ActorContext[] = [
    globalAdmin(),
    actor({ globalCapabilities: new Set(['user_admin']) }),
    actor({ globalCapabilities: new Set(['org_admin']) }),
    actor({ globalCapabilities: new Set(['audit_viewer']) }),
    actor({ globalCapabilities: new Set(['support']) }),
    orgLead(),
    actor(),
  ];

  it('never advertises a screen whose endpoint would refuse the caller', () => {
    for (const subject of cases) {
      const capabilities = adminCapabilities(subject);
      expect(capabilities.canAdministerUsers).toBe(canAdministerUsers(subject).allowed);
      expect(capabilities.canViewAuditLog).toBe(canViewAuditLog(subject).allowed);
      expect(capabilities.canViewPermissionOverview)
        .toBe(canViewPermissionOverview(subject).allowed);
      expect(capabilities.canViewSystemConfiguration)
        .toBe(canViewSystemConfiguration(subject).allowed);
      expect(capabilities.canGrantCapabilities)
        .toBe(canGrantGlobalCapability(subject, capabilityChange()).allowed);
    }
  });

  it('opens everything to a global administrator', () => {
    expect(Object.values(adminCapabilities(globalAdmin())).every(Boolean)).toBe(true);
  });
});

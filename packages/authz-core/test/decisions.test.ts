import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '@leoos/contracts';
import {
  can, canAssignRole, canChangeRolePermissions, canClearPermissionOverride,
  canCreateRole, canDeleteRole, canEditRole, canGrantPermissions, canManageMember,
  canMoveRole, canSetPermissionOverride,
  canEditOrganization, canViewOrganization, canViewOrganizationSection,
  effectiveLevel, effectivePermissions, outranks, UNBOUNDED_LEVEL,
  type ActorContext, type RoleRef, type TargetContext,
} from '../src/index.js';

const ORG = 'org-pd';
const OTHER_ORG = 'org-ice';

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

function target(overrides: Partial<TargetContext> = {}): TargetContext {
  return {
    userId: 'target',
    organizationId: ORG,
    level: 30,
    isOrgLead: false,
    isGlobalAdmin: false,
    ...overrides,
  };
}

function role(level: number, organizationId: string | null = ORG): RoleRef {
  return { id: `role-${level}`, organizationId, hierarchyLevel: level };
}

/** The refusal reason, or null when the decision allowed. */
function reasonOf(decision: { allowed: boolean; reason?: string }): string | null {
  return decision.allowed ? null : decision.reason ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('H1 — rank comparison is strictly greater-than', () => {
  it('allows managing a lower rank', () => {
    expect(canManageMember(actor({ level: 60 }), target({ level: 30 })).allowed).toBe(true);
  });

  it('refuses managing an EQUAL rank — peers are mutually immune', () => {
    const decision = canManageMember(actor({ level: 60 }), target({ level: 60 }));
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ reason: 'TARGET_RANK_NOT_LOWER' });
  });

  it('refuses managing a higher rank', () => {
    expect(canManageMember(actor({ level: 30 }), target({ level: 60 })).allowed).toBe(false);
  });

  it('is exhaustively correct across the whole level matrix', () => {
    for (let a = 1; a <= 100; a += 7) {
      for (let t = 1; t <= 100; t += 7) {
        const decision = canManageMember(
          actor({ level: a }),
          target({ level: t, userId: 'other' }),
        );
        expect(decision.allowed, `actor ${a} vs target ${t}`).toBe(a > t);
      }
    }
  });
});

describe('H6 — self-management', () => {
  it('refuses managing your own membership even at maximum rank', () => {
    const decision = canManageMember(
      actor({ userId: 'same', level: 100 }),
      target({ userId: 'same', level: 10 }),
    );
    expect(decision).toMatchObject({ allowed: false, reason: 'SELF_ACTION_FORBIDDEN' });
  });
});

describe('H7 — organization scope', () => {
  it('refuses acting across organizations', () => {
    const decision = canManageMember(
      actor({ level: 100 }),
      target({ organizationId: OTHER_ORG, level: 1 }),
    );
    expect(decision).toMatchObject({ allowed: false, reason: 'CROSS_ORGANIZATION' });
  });

  it('refuses when the actor has no organization context', () => {
    expect(canManageMember(actor({ organizationId: null }), target()).allowed).toBe(false);
  });
});

describe('H2 — role assignment blocks self-promotion', () => {
  it('allows assigning a strictly lower role', () => {
    expect(canAssignRole(actor({ level: 60 }), role(50)).allowed).toBe(true);
  });

  it('refuses assigning a role at the actor\'s own level', () => {
    expect(canAssignRole(actor({ level: 60 }), role(60))).toMatchObject({
      allowed: false, reason: 'ROLE_LEVEL_TOO_HIGH',
    });
  });

  it('refuses assigning a higher role — the indirect self-promotion route', () => {
    expect(canAssignRole(actor({ level: 30 }), role(90)).allowed).toBe(false);
  });

  it('refuses handing out a global role from inside an organization', () => {
    expect(canAssignRole(actor({ level: 100 }), role(10, null))).toMatchObject({
      allowed: false, reason: 'CROSS_ORGANIZATION',
    });
  });
});

describe('H3/H5 — role editing blocks role laundering', () => {
  it('refuses editing a role at or above the actor\'s level', () => {
    // "Edit the Chief role to add my permissions, then assign it to myself."
    expect(canEditRole(actor({ level: 60 }), role(100)).allowed).toBe(false);
    expect(canEditRole(actor({ level: 60 }), role(60)).allowed).toBe(false);
  });

  it('allows editing a strictly lower role', () => {
    expect(canEditRole(actor({ level: 60 }), role(59)).allowed).toBe(true);
  });

  it('refuses creating a role at or above the actor\'s own level', () => {
    expect(canCreateRole(actor({ level: 50 }), 50).allowed).toBe(false);
    expect(canCreateRole(actor({ level: 50 }), 80).allowed).toBe(false);
    expect(canCreateRole(actor({ level: 50 }), 49).allowed).toBe(true);
  });
});

describe('H4 — the permission subset rule', () => {
  it('allows granting permissions the actor holds', () => {
    const a = actor({ permissions: new Set<PermissionKey>(['persons.view', 'persons.edit']) });
    expect(canGrantPermissions(a, ['persons.view']).allowed).toBe(true);
  });

  it('refuses granting a permission the actor does not hold', () => {
    const a = actor({ permissions: new Set<PermissionKey>(['persons.view']) });
    expect(canGrantPermissions(a, ['persons.view', 'personnel.fire'])).toMatchObject({
      allowed: false, reason: 'PERMISSION_NOT_HELD_BY_ACTOR',
    });
  });

  it('refuses granting a global permission from an organization context', () => {
    // This is what stops a chief writing themselves an admin role.
    const a = actor({ level: 100, permissions: new Set<PermissionKey>(['admin.users']) });
    expect(canGrantPermissions(a, ['admin.users'])).toMatchObject({
      allowed: false, reason: 'GLOBAL_PERMISSION_ON_ORG_ROLE',
    });
  });

  it('refuses even an organization lead a global permission', () => {
    expect(canGrantPermissions(actor({ isOrgLead: true }), ['admin.audit_logs']).allowed).toBe(false);
  });
});

describe('organization lead', () => {
  it('may manage any ordinary member of their own organization', () => {
    const lead = actor({ isOrgLead: true, level: UNBOUNDED_LEVEL });
    expect(canManageMember(lead, target({ level: 100 })).allowed).toBe(true);
  });

  it('may not manage another lead of the same organization', () => {
    const lead = actor({ isOrgLead: true, level: UNBOUNDED_LEVEL });
    expect(canManageMember(lead, target({ isOrgLead: true })).allowed).toBe(false);
  });

  it('confers nothing in another organization', () => {
    const lead = actor({ isOrgLead: true, level: UNBOUNDED_LEVEL });
    expect(canManageMember(lead, target({ organizationId: OTHER_ORG }))).toMatchObject({
      allowed: false, reason: 'CROSS_ORGANIZATION',
    });
  });

  it('cannot be managed by an ordinary member at maximum rank', () => {
    expect(canManageMember(actor({ level: 100 }), target({ isOrgLead: true }))).toMatchObject({
      allowed: false, reason: 'TARGET_IS_ORG_LEAD',
    });
  });

  it('holds every organization-scoped permission implicitly', () => {
    // The capability is granted to a PERSON, not to a rank: a lead's nominal
    // role is often a low one. Reading their authority off their role set alone
    // would leave the lead of PD unable to hire or fire anybody in PD.
    const lead = actor({ isOrgLead: true, level: UNBOUNDED_LEVEL, permissions: new Set() });
    expect(can(lead, 'personnel.fire')).toBe(true);
    expect(can(lead, 'personnel.promote')).toBe(true);
    expect(can(lead, 'roles.assign')).toBe(true);
    expect(can(lead, 'organization.edit')).toBe(true);
  });

  it('holds NO global-scope permission', () => {
    // Running one organization must never become running the system.
    const lead = actor({ isOrgLead: true, level: UNBOUNDED_LEVEL, permissions: new Set() });
    expect(can(lead, 'admin.users')).toBe(false);
    expect(can(lead, 'admin.audit_logs')).toBe(false);
    expect(can(lead, 'admin.purge')).toBe(false);
    expect(can(lead, 'admin.impersonate')).toBe(false);
  });

  it('holds nothing once their membership is no longer active', () => {
    const lead = actor({
      isOrgLead: true, level: UNBOUNDED_LEVEL,
      permissions: new Set(), membershipActive: false,
    });
    expect(can(lead, 'personnel.fire')).toBe(false);
  });

  it('confers no permission in another organization', () => {
    // `isOrgLead` is resolved for the organization the context is scoped to, so
    // a lead of PD carries no lead flag while acting against MD.
    const actingElsewhere = actor({ isOrgLead: false, level: 0, permissions: new Set() });
    expect(can(actingElsewhere, 'personnel.fire')).toBe(false);
  });
});

describe('global admin', () => {
  it('bypasses hierarchy but is not itself manageable by an organization', () => {
    const admin = actor({ isGlobalAdmin: true, level: UNBOUNDED_LEVEL });
    expect(canManageMember(admin, target({ level: 100, isOrgLead: true })).allowed).toBe(true);
    expect(canManageMember(actor({ level: 100 }), target({ isGlobalAdmin: true }))).toMatchObject({
      allowed: false, reason: 'TARGET_IS_GLOBAL_ADMIN',
    });
  });

  it('holds every permission implicitly', () => {
    expect(can(actor({ isGlobalAdmin: true }), 'admin.purge')).toBe(true);
  });
});

describe('inactive membership', () => {
  it('can manage nobody', () => {
    expect(canManageMember(actor({ membershipActive: false, level: 100 }), target())).toMatchObject({
      allowed: false, reason: 'NO_ACTIVE_MEMBERSHIP',
    });
  });

  it('cannot assign roles or grant permissions', () => {
    const a = actor({ membershipActive: false, level: 100, permissions: new Set<PermissionKey>(['roles.assign']) });
    expect(canAssignRole(a, role(10)).allowed).toBe(false);
    expect(canGrantPermissions(a, ['roles.assign']).allowed).toBe(false);
  });
});

describe('effective level and permissions', () => {
  it('takes the MAXIMUM role level, never the sum', () => {
    expect(effectiveLevel([10, 30, 20])).toBe(30);
    // Two junior roles must never manufacture a senior one.
    expect(effectiveLevel([10, 10])).toBe(10);
    expect(effectiveLevel([])).toBe(0);
  });

  it('applies deny over grant', () => {
    const result = effectivePermissions({
      rolePermissions: ['persons.view', 'persons.edit'],
      grants: ['vehicles.view'],
      denies: ['persons.edit'],
    });
    expect([...result].sort()).toEqual(['persons.view', 'vehicles.view']);
  });

  it('deny wins even when the same key is also granted', () => {
    const result = effectivePermissions({
      rolePermissions: [],
      grants: ['personnel.fire'],
      denies: ['personnel.fire'],
    });
    expect(result.has('personnel.fire')).toBe(false);
  });
});

describe('property: no operation ever escalates the actor', () => {
  it('never lets an actor assign a role at or above their own level', () => {
    for (let level = 1; level <= 100; level += 1) {
      for (const roleLevel of [level - 1, level, level + 1]) {
        if (roleLevel < 1 || roleLevel > 100) continue;
        const allowed = canAssignRole(actor({ level }), role(roleLevel)).allowed;
        expect(allowed, `level ${level} assigning ${roleLevel}`).toBe(roleLevel < level);
      }
    }
  });

  it('never lets an actor grant a permission outside their own set', () => {
    const held: PermissionKey[] = ['persons.view', 'vehicles.view'];
    const a = actor({ permissions: new Set(held) });
    const all: PermissionKey[] = [
      'persons.view', 'vehicles.view', 'persons.edit', 'personnel.fire', 'roles.delete',
    ];
    for (const key of all) {
      expect(canGrantPermissions(a, [key]).allowed, key).toBe(held.includes(key));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the rank comparison policy', () => {
  it('requires STRICTLY higher, so equal ranks are mutually immune', () => {
    expect(outranks(60, 50)).toBe(true);
    expect(outranks(50, 50)).toBe(false);
    expect(outranks(50, 60)).toBe(false);
  });
});

describe('moving a role to a different level', () => {
  it('REFUSES lifting a role the actor may edit ABOVE the actor', () => {
    // The attack a single-ended check misses: a Lieutenant (60) may edit the
    // Sergeant role (50), so an origin-only check passes — and they lift it to
    // 90, manufacturing a rank above themselves to be promoted into.
    expect(canMoveRole(actor({ level: 60 }), role(50), 90)).toMatchObject({
      allowed: false, reason: 'ROLE_LEVEL_TOO_HIGH',
    });
  });

  it('REFUSES lifting a role to the actor\'s OWN level', () => {
    expect(canMoveRole(actor({ level: 60 }), role(50), 60).allowed).toBe(false);
  });

  it('REFUSES dragging a role from ABOVE the actor down to below', () => {
    // The mirror attack: a destination-only check would let a Lieutenant reach
    // up to the Chief role and demote the whole command structure.
    expect(canMoveRole(actor({ level: 60 }), role(100), 10)).toMatchObject({
      allowed: false, reason: 'ROLE_LEVEL_TOO_HIGH',
    });
  });

  it('ALLOWS a move that stays strictly below the actor at both ends', () => {
    expect(canMoveRole(actor({ level: 60 }), role(20), 50).allowed).toBe(true);
  });

  it('REFUSES a level outside the 1–100 scale', () => {
    expect(canMoveRole(actor({ level: 100 }), role(20), 0)).toMatchObject({
      allowed: false, reason: 'LEVEL_OUT_OF_RANGE',
    });
    expect(canMoveRole(actor({ level: 100 }), role(20), 101)).toMatchObject({
      allowed: false, reason: 'LEVEL_OUT_OF_RANGE',
    });
  });

  it('lets a global admin move any role', () => {
    const admin = actor({ isGlobalAdmin: true, level: UNBOUNDED_LEVEL });
    expect(canMoveRole(admin, role(100), 99).allowed).toBe(true);
  });
});

describe('deleting a role', () => {
  it('REFUSES a role above the actor', () => {
    expect(canDeleteRole(actor({ level: 60 }), role(90))).toMatchObject({
      allowed: false, reason: 'ROLE_LEVEL_TOO_HIGH',
    });
  });

  it('REFUSES a role at the actor\'s own level', () => {
    expect(canDeleteRole(actor({ level: 60 }), role(60)).allowed).toBe(false);
  });

  it('REFUSES a system role, whatever the rank', () => {
    const admin = actor({ isGlobalAdmin: true, level: UNBOUNDED_LEVEL });
    expect(canDeleteRole(admin, { ...role(10), isSystem: true })).toMatchObject({
      allowed: false, reason: 'ROLE_IS_SYSTEM',
    });
  });

  it('REFUSES the default role — new hires would have nothing to receive', () => {
    const admin = actor({ isGlobalAdmin: true, level: UNBOUNDED_LEVEL });
    expect(canDeleteRole(admin, { ...role(10), isDefault: true })).toMatchObject({
      allowed: false, reason: 'ROLE_IS_DEFAULT',
    });
  });

  it('ALLOWS an ordinary role below the actor', () => {
    expect(canDeleteRole(actor({ level: 60 }), role(30)).allowed).toBe(true);
  });
});

describe('changing a role\'s permission set', () => {
  const held: PermissionKey[] = ['persons.view', 'persons.edit', 'dispatch.close'];

  it('REFUSES adding a permission the actor does not hold', () => {
    // Role laundering, the direct form: write the permission into a role you
    // control, then have it assigned to you.
    expect(canChangeRolePermissions(actor({ level: 60, permissions: new Set(held) }), role(30), ['personnel.fire']))
      .toMatchObject({ allowed: false, reason: 'PERMISSION_NOT_HELD_BY_ACTOR' });
  });

  it('REFUSES editing a role ABOVE the actor, even adding nothing', () => {
    expect(canChangeRolePermissions(actor({ level: 60, permissions: new Set(held) }), role(90), []))
      .toMatchObject({ allowed: false, reason: 'ROLE_LEVEL_TOO_HIGH' });
  });

  it('REFUSES a global-scope permission on an organization role', () => {
    const chief = actor({ level: 100, permissions: new Set<PermissionKey>(['admin.users']) });
    expect(canChangeRolePermissions(chief, role(90), ['admin.users']))
      .toMatchObject({ allowed: false, reason: 'GLOBAL_PERMISSION_ON_ORG_ROLE' });
  });

  it('ALLOWS adding permissions the actor holds, to a role below them', () => {
    expect(canChangeRolePermissions(actor({ level: 60, permissions: new Set(held) }), role(30), ['persons.edit']).allowed)
      .toBe(true);
  });

  it('ALLOWS a removal-only change without holding the permission', () => {
    // Removal cannot raise anyone's authority, and requiring the permission to
    // remove it would strand a role that drifted above its editor.
    expect(canChangeRolePermissions(actor({ level: 60, permissions: new Set() }), role(30), []).allowed)
      .toBe(true);
  });
});

describe('property: combining roles never manufactures authority', () => {
  it('never produces a level above the highest single role', () => {
    const sets = [[10, 20], [30, 30], [1, 99], [50, 50, 50], [10, 20, 30, 40]];
    for (const levels of sets) {
      const combined = effectiveLevel(levels);
      expect(combined, `levels ${levels.join(',')}`).toBe(Math.max(...levels));
      // The failure mode this rules out: summing would put [50,50] at 100.
      expect(combined).toBeLessThanOrEqual(Math.max(...levels));
    }
  });

  it('never produces a permission that no contributing role carried', () => {
    const roleA: PermissionKey[] = ['persons.view', 'dispatch.view'];
    const roleB: PermissionKey[] = ['vehicles.view'];
    const union = new Set([...roleA, ...roleB]);

    const combined = effectivePermissions({
      rolePermissions: [...roleA, ...roleB], grants: [], denies: [],
    });

    for (const key of combined) expect(union.has(key), key).toBe(true);
    expect(combined.size).toBe(union.size);
  });

  it('is order-independent — the same roles always give the same result', () => {
    const a: PermissionKey[] = ['persons.view', 'persons.edit'];
    const b: PermissionKey[] = ['persons.edit', 'vehicles.view'];

    const forwards = effectivePermissions({ rolePermissions: [...a, ...b], grants: [], denies: [] });
    const backwards = effectivePermissions({ rolePermissions: [...b, ...a], grants: [], denies: [] });

    expect([...forwards].sort()).toEqual([...backwards].sort());
  });

  it('lets a deny beat a grant arriving from any role', () => {
    const result = effectivePermissions({
      rolePermissions: ['personnel.fire', 'personnel.fire'],
      grants: ['personnel.fire'],
      denies: ['personnel.fire'],
    });
    expect(result.has('personnel.fire')).toBe(false);
  });
});

describe('property: no role mutation ever escalates the actor', () => {
  it('never lets an actor move a role to at-or-above their own level', () => {
    for (let level = 2; level <= 100; level += 7) {
      for (const nextLevel of [level - 1, level, level + 1]) {
        if (nextLevel < 1 || nextLevel > 100) continue;
        const allowed = canMoveRole(actor({ level }), role(1), nextLevel).allowed;
        expect(allowed, `level ${level} moving a role to ${nextLevel}`).toBe(nextLevel < level);
      }
    }
  });

  it('never lets an actor edit, move or delete a role at or above their own', () => {
    for (let level = 1; level <= 100; level += 9) {
      for (const roleLevel of [level, level + 1]) {
        if (roleLevel > 100) continue;
        const a = actor({ level });
        expect(canEditRole(a, role(roleLevel)).allowed, `edit ${roleLevel} as ${level}`).toBe(false);
        expect(canDeleteRole(a, role(roleLevel)).allowed, `delete ${roleLevel} as ${level}`).toBe(false);
        expect(canMoveRole(a, role(roleLevel), 1).allowed, `move ${roleLevel} as ${level}`).toBe(false);
        expect(canCreateRole(a, roleLevel).allowed, `create ${roleLevel} as ${level}`).toBe(false);
      }
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// An inactive membership confers nothing, including through a lead grant
// ═══════════════════════════════════════════════════════════════════════════

describe('an Organization Lead with an inactive membership holds nothing', () => {
  /**
   * REGRESSION — found by the security audit.
   *
   * `organization_lead` and `organization_member.status` are separate rows
   * changed by separate operations: firing somebody does not revoke their lead
   * grant. The API's actor context conferred `isOrgLead` and
   * `level: UNBOUNDED_LEVEL` from the grant alone, and the three organization
   * VIEW decisions read `isOrgLead` without checking `membershipActive` — so a
   * fired chief kept reading the roster, the units and the vehicles of the
   * organization that had just fired them.
   *
   * Asserted over EVERY decision that takes an actor, so a new one that forgets
   * the guard shows up here rather than in production. The context no longer
   * asserts a lead grant on an inactive membership either; this is the second
   * lock on the same door.
   */
  const firedLead = actor({
    isOrgLead: true,
    membershipActive: false,
    // The level a lead used to arrive with, so this test would pass for the
    // wrong reason if the fix had only been to zero the level.
    level: UNBOUNDED_LEVEL,
  });

  it('is refused by every organization decision', () => {
    expect(canViewOrganization(firedLead, ORG).allowed).toBe(false);
    expect(canEditOrganization(firedLead, ORG).allowed).toBe(false);
    expect(
      canViewOrganizationSection(firedLead, ORG, 'personnel.view').allowed,
    ).toBe(false);
    expect(canViewOrganizationSection(firedLead, ORG, 'roles.view').allowed).toBe(false);
    expect(canViewOrganizationSection(firedLead, ORG, 'vehicles.view').allowed).toBe(false);
    expect(canViewOrganizationSection(firedLead, ORG, 'dispatch.view').allowed).toBe(false);
  });

  it('is refused by every management decision', () => {
    expect(canManageMember(firedLead, target()).allowed).toBe(false);
    expect(canAssignRole(firedLead, role(10)).allowed).toBe(false);
    expect(canEditRole(firedLead, role(10)).allowed).toBe(false);
    expect(canCreateRole(firedLead, 10).allowed).toBe(false);
    expect(canDeleteRole(firedLead, role(10)).allowed).toBe(false);
    expect(canMoveRole(firedLead, role(10), 20).allowed).toBe(false);
    expect(canGrantPermissions(firedLead, ['personnel.view']).allowed).toBe(false);
    expect(canChangeRolePermissions(firedLead, role(10), ['personnel.view']).allowed).toBe(false);
  });

  it('holds no permission at all', () => {
    expect(can(firedLead, 'personnel.view')).toBe(false);
    expect(can(firedLead, 'dispatch.view')).toBe(false);
    expect(can(firedLead, 'organization.edit')).toBe(false);
  });

  it('says NO_ACTIVE_MEMBERSHIP rather than blaming a permission', () => {
    // The reason matters: "you lack organization.view" would send a fired chief
    // to ask for a permission, when the answer is that they no longer work here.
    expect(reasonOf(canViewOrganization(firedLead, ORG))).toBe('NO_ACTIVE_MEMBERSHIP');
    expect(
      reasonOf(canViewOrganizationSection(firedLead, ORG, 'personnel.view')),
    ).toBe('NO_ACTIVE_MEMBERSHIP');
  });

  it('still allows an ACTIVE lead everything inside their organization', () => {
    const lead = actor({ isOrgLead: true, membershipActive: true, level: UNBOUNDED_LEVEL });
    expect(canViewOrganization(lead, ORG).allowed).toBe(true);
    expect(canEditOrganization(lead, ORG).allowed).toBe(true);
    expect(canViewOrganizationSection(lead, ORG, 'personnel.view').allowed).toBe(true);
    expect(canManageMember(lead, target()).allowed).toBe(true);
    expect(can(lead, 'personnel.view')).toBe(true);
  });

  it('and still refuses an active lead ANOTHER organization', () => {
    const lead = actor({ isOrgLead: true, membershipActive: true, level: UNBOUNDED_LEVEL });
    expect(reasonOf(canViewOrganization(lead, OTHER_ORG))).toBe('CROSS_ORGANIZATION');
    expect(reasonOf(canViewOrganizationSection(lead, OTHER_ORG, 'personnel.view')))
      .toBe('CROSS_ORGANIZATION');
  });

  /**
   * A SUSPENDED member is not a lesser case of a terminated one — they are the
   * same case, and the difference is only that a suspension is expected to end.
   */
  it('treats a suspended lead exactly as a terminated one', () => {
    const suspended = actor({ isOrgLead: true, membershipActive: false, level: UNBOUNDED_LEVEL });
    expect(canViewOrganization(suspended, ORG).allowed).toBe(false);
    expect(canManageMember(suspended, target()).allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H8 — per-member permission overrides
// ═══════════════════════════════════════════════════════════════════════════

describe('H8 — granting a permission to one person', () => {
  const MEDICAL = 'persons.medical.view' as PermissionKey;
  const ADMIN_KEY = 'admin.users' as PermissionKey;

  const chief = (extra: Partial<ActorContext> = {}) => actor({
    level: 90, permissions: new Set<PermissionKey>([MEDICAL]), ...extra,
  });

  it('allows a senior member to grant a permission they hold', () => {
    expect(canSetPermissionOverride(chief(), target(), MEDICAL, 'grant').allowed).toBe(true);
  });

  it('REFUSES granting a permission the actor does not hold', () => {
    const withoutIt = actor({ level: 90, permissions: new Set<PermissionKey>() });
    const decision = canSetPermissionOverride(withoutIt, target(), MEDICAL, 'grant');
    expect(decision.allowed).toBe(false);
    expect(reasonOf(decision)).toBe('PERMISSION_NOT_HELD_BY_ACTOR');
  });

  it('REFUSES an override on somebody of equal rank', () => {
    // H1 is strictly-greater-than. Peers are mutually immune, and an override
    // is a management action like any other.
    const peer = target({ level: 90 });
    const decision = canSetPermissionOverride(chief(), peer, MEDICAL, 'grant');
    expect(decision.allowed).toBe(false);
    expect(reasonOf(decision)).toBe('TARGET_RANK_NOT_LOWER');
  });

  it('REFUSES an override on somebody senior', () => {
    const senior = target({ level: 95 });
    expect(canSetPermissionOverride(chief(), senior, MEDICAL, 'grant').allowed).toBe(false);
  });

  it('REFUSES writing an override for YOURSELF, which is the whole game', () => {
    const self = target({ userId: 'actor', level: 10 });
    const decision = canSetPermissionOverride(chief(), self, MEDICAL, 'grant');
    expect(decision.allowed).toBe(false);
    expect(reasonOf(decision)).toBe('SELF_ACTION_FORBIDDEN');
  });

  it('REFUSES an override on a member of another organization', () => {
    const foreign = target({ organizationId: OTHER_ORG });
    const decision = canSetPermissionOverride(chief(), foreign, MEDICAL, 'grant');
    expect(decision.allowed).toBe(false);
    expect(reasonOf(decision)).toBe('CROSS_ORGANIZATION');
  });

  it('REFUSES a GLOBAL-scope permission, whatever the rank', () => {
    // An organization role cannot carry one, so an override for one would be a
    // row that reads like a control and does nothing.
    for (const effect of ['grant', 'deny'] as const) {
      const decision = canSetPermissionOverride(chief(), target(), ADMIN_KEY, effect);
      expect(decision.allowed, effect).toBe(false);
      expect(reasonOf(decision), effect).toBe('GLOBAL_PERMISSION_ON_ORG_ROLE');
    }
  });

  it('REFUSES a global-scope override even to an Organization Lead', () => {
    const lead = actor({ isOrgLead: true, level: UNBOUNDED_LEVEL });
    expect(canSetPermissionOverride(lead, target(), ADMIN_KEY, 'grant').allowed).toBe(false);
  });

  it('REFUSES an override written by somebody with no active membership', () => {
    const suspended = chief({ membershipActive: false });
    expect(canSetPermissionOverride(suspended, target(), MEDICAL, 'grant').allowed).toBe(false);
  });

  it('lets an Organization Lead grant anything organization-scoped in their own org', () => {
    const lead = actor({ isOrgLead: true, level: UNBOUNDED_LEVEL });
    expect(canSetPermissionOverride(lead, target(), MEDICAL, 'grant').allowed).toBe(true);
  });

  it('REFUSES an override on a global administrator', () => {
    const admin = target({ isGlobalAdmin: true, level: 10 });
    expect(canSetPermissionOverride(chief(), admin, MEDICAL, 'grant').allowed).toBe(false);
  });
});

describe('H8 — a deny is not a grant', () => {
  const MEDICAL = 'persons.medical.view' as PermissionKey;

  it('lets a senior member DENY a permission they do not themselves hold', () => {
    /**
     * The asymmetry, stated as a test because it looks like a hole and is not.
     *
     * A deny only ever REDUCES the target's authority. Requiring the actor to
     * hold the key first would mean a chief who does not personally use medical
     * records could not stop a subordinate from using them — backwards, and
     * inconsistent with roles, where a removal-only change is already allowed
     * without holding the key.
     */
    const withoutIt = actor({ level: 90, permissions: new Set<PermissionKey>() });
    expect(canSetPermissionOverride(withoutIt, target(), MEDICAL, 'deny').allowed).toBe(true);
  });

  it('still refuses a deny against somebody at or above the actor', () => {
    // The rank check is not relaxed. A deny is not an attack on somebody senior.
    const withoutIt = actor({ level: 90, permissions: new Set<PermissionKey>() });
    for (const level of [90, 95]) {
      expect(canSetPermissionOverride(withoutIt, target({ level }), MEDICAL, 'deny').allowed)
        .toBe(false);
    }
  });

  it('still refuses a deny against yourself', () => {
    const withoutIt = actor({ level: 90, permissions: new Set<PermissionKey>() });
    const self = target({ userId: 'actor', level: 10 });
    expect(canSetPermissionOverride(withoutIt, self, MEDICAL, 'deny').allowed).toBe(false);
  });
});

describe('H8 — clearing an override', () => {
  const MEDICAL = 'persons.medical.view' as PermissionKey;

  it('needs rank and scope, but not the permission itself', () => {
    /**
     * Clearing a DENY restores authority the member's own role already carried,
     * which looks like an escalation and is not: that permission was put in the
     * role by somebody with the authority to write it. Refusing here would mean
     * a deny applied by a chief could never be lifted by anyone who did not
     * personally hold the key.
     */
    const withoutIt = actor({ level: 90, permissions: new Set<PermissionKey>() });
    expect(canClearPermissionOverride(withoutIt, target()).allowed).toBe(true);
  });

  it('refuses across organizations, at equal rank, and on yourself', () => {
    const chief = actor({ level: 90, permissions: new Set<PermissionKey>([MEDICAL]) });
    expect(canClearPermissionOverride(chief, target({ organizationId: OTHER_ORG })).allowed)
      .toBe(false);
    expect(canClearPermissionOverride(chief, target({ level: 90 })).allowed).toBe(false);
    expect(canClearPermissionOverride(chief, target({ userId: 'actor' })).allowed).toBe(false);
  });
});

describe('H8 — property: an override can never escalate the actor', () => {
  it('never lets an actor grant themselves anything, at any rank or permission set', () => {
    const keys = [
      'persons.medical.view', 'personnel.hire', 'dispatch.close', 'roles.edit',
      'admin.users', 'admin.audit_logs',
    ] as PermissionKey[];

    for (const level of [0, 10, 50, 90, 100, UNBOUNDED_LEVEL]) {
      for (const isOrgLead of [false, true]) {
        for (const key of keys) {
          for (const effect of ['grant', 'deny'] as const) {
            const a = actor({ level, isOrgLead, permissions: new Set(keys) });
            const self = target({ userId: a.userId, level: 0 });
            expect(
              canSetPermissionOverride(a, self, key, effect).allowed,
              `level ${level} lead ${isOrgLead} ${effect} ${key}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it('never lets an actor grant a key outside their own set to anybody', () => {
    const held = ['dispatch.view'] as PermissionKey[];
    const notHeld = ['persons.medical.view', 'personnel.hire', 'roles.edit'] as PermissionKey[];

    for (const level of [10, 50, 90, 100]) {
      const a = actor({ level, permissions: new Set(held) });
      for (const key of notHeld) {
        expect(
          canSetPermissionOverride(a, target({ level: 0 }), key, 'grant').allowed,
          `${key} at ${level}`,
        ).toBe(false);
      }
    }
  });
});

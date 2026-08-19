import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '@leoos/contracts';
import {
  can, canAssignRole, canCreateRole, canEditRole, canGrantPermissions, canManageMember,
  effectiveLevel, effectivePermissions, UNBOUNDED_LEVEL,
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

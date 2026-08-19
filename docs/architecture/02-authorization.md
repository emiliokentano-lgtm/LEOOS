# 02 — Authentication & Authorization

> **Status: Part A implemented, Part B partially implemented.**
> Organization scoping is now built and proven: `packages/authz-core` carries the
> scope decisions, `apps/api/src/modules/organizations` enforces them, and 23
> tests assert that a lead of one organization can do nothing in another.
> Authentication (`apps/api/src/modules/auth`) is complete. The authorization
> KERNEL exists as pure functions in `packages/authz-core` with 31 tests
> including an exhaustive rank matrix, and context resolution is implemented in
> `apps/api/src/modules/auth/context.service.ts` with both the cached and the
> `FOR UPDATE` loaders. What is NOT yet built: the personnel and role mutation
> endpoints that consume it, and the version-keyed permission cache (§B.6) —
> every request currently re-resolves memberships. Those land in Phase 2.

This is the highest-risk area of the system. It is specified here in more detail
than anything else because a subtle mistake here is a privilege-escalation
vulnerability, not a cosmetic bug.

---

## Part A — Authentication

### A.1 Password handling
- **Argon2id**, parameters `m=19456 KiB, t=2, p=1` (OWASP 2024 baseline), tuned on
  the target host at deploy time and recorded in config.
- Parameters are encoded in the stored hash, so they can be raised later and
  existing hashes are transparently rehashed on next successful login.
- Minimum length 12, no composition rules, checked against a compromised-password
  list (offline k-anonymity list bundled at build time — no third-party call).
- Timing-safe verification. On unknown email, a dummy hash is still verified so
  response time does not reveal account existence.

### A.2 Sessions
Opaque, server-side, revocable. Not JWT. The reason is operational: when someone
is fired or an account is compromised, access must end *now*, and a stateless
token cannot be withdrawn.

- 256 bits of CSPRNG entropy, base64url encoded.
- Only `SHA-256(token)` is stored. A database leak yields no usable sessions.
- Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, host-only.
- Sliding expiry 12 h of inactivity, absolute cap 7 days.
- The session ID is **rotated** on login, on password change, and on any change to
  the user's global capabilities.
- Session lookup is cached in Redis for 30 s with an explicit invalidation channel,
  so a revocation propagates in under a second without a database read per request.

Revocation cascade:

| Event | Effect |
| --- | --- |
| Logout | that session revoked |
| Password change / reset | all other sessions revoked |
| Account suspended or disabled | all sessions revoked |
| Membership terminated | sessions kept, permissions recomputed immediately |
| Global capability changed | session rotated, permission cache flushed |

### A.3 CSRF
`SameSite=Lax` blocks the common cases. On top of that, all state-changing
requests must carry an `X-LEOOS-CSRF` header holding a value from a
non-`HttpOnly` companion cookie (double submit), and the API rejects
state-changing requests whose `Origin` is not allow-listed. Three independent
mechanisms, none of which is load-bearing alone.

### A.4 Verification and reset architecture
Both flows use the same `auth_token` table and the same rules:

- 256-bit token, stored hashed, single use (`consumed_at` set inside the same
  transaction that performs the action).
- Verification tokens live 24 h; reset tokens live 1 h.
- Requesting a reset always returns the same generic response and takes
  approximately the same time, regardless of whether the account exists.
- Issuing a new token invalidates all prior unconsumed tokens of that purpose.
- Reset consumption revokes every session for that user.
- Rate limited per email and per IP.

Email delivery is behind a `MailTransport` interface. Phase 1 ships a console/file
transport; SMTP is a config change, not a code change. This keeps the
architecture complete without picking an email vendor prematurely.

### A.5 Two-factor (architecture, deferred implementation)
TOTP, secret encrypted at rest with a key from config, ten single-use recovery
codes stored as Argon2id hashes. Design intent: 2FA is **required** for accounts
holding any `risk = 'high'` permission or any global capability. The schema
supports it from Phase 1; enforcement lands in Phase 8.

### A.6 Anti-automation
| Surface | Limit |
| --- | --- |
| Login | 5 / 15 min per (email + IP), progressive account lockout after 10 failures |
| Register | 3 / hour per IP |
| Password reset request | 3 / hour per email, 10 / hour per IP |
| Verification resend | 3 / hour per account |
| General API | 300 / min per session, 60 / min per IP unauthenticated |
| Search endpoints | 30 / min per user (also audited) |

### A.7 Serialization boundary (rule 16)

Secrets must not merely be *omitted* from responses — they must be structurally
incapable of reaching one. Selecting a whole row and forgetting to strip a field is
the normal way password hashes leak.

Therefore: **API responses are assembled from DTO types declared in
`packages/contracts`, never from ORM rows.** Returning a `db.select()` result
directly from a route handler is a lint error, not a code-review catch.

Fields that must never leave the API process under any circumstance:

| Field | Table |
| --- | --- |
| `password_hash` | `user_account` |
| `totp_secret_enc`, recovery-code hashes | `user_account` |
| `token_hash` | `session`, `auth_token` |
| `secret_hash` | `game_server_credential` |

The FiveM credential secret is shown exactly once, at creation, in the response to
the create call — it is never stored in plaintext and never retrievable again.
Losing it means rotating the key, which is a supported one-minute operation.

A test asserts that the serialized form of every auth-related DTO contains none of
these keys, so adding a field to a table cannot quietly widen a response.

---

## Part B — Authorization

### B.1 Model

```
user_account
   ├── user_global_role[]                    → global capabilities
   └── organization_member (per org)
          ├── member_role[] ──→ role ──→ role_permission[] ──→ permission
          ├── member_permission_override[]   → grant / deny
          └── organization_lead?             → org-scoped superuser
```

**Effective permissions for (user, organization):**

```
base      = ⋃ role_permission[r] for r in member_roles
granted   = base ∪ { overrides where effect = 'grant' and not expired }
effective = granted \ { overrides where effect = 'deny' }
```

Deny always wins. An organization lead's effective set is every
`scope = 'organization'` permission — never a global one. A `global_admin`'s
effective set is all permissions in every organization.

**Effective hierarchy level for (user, organization):**

```
level = max(role.hierarchy_level for role in member_roles)   default 0
level = ∞   if user is organization_lead of this organization
level = ∞   if user has global_admin
```

Maximum, not sum: holding a junior specialist role in addition to Lieutenant must
not dilute a lieutenant's authority, and holding two junior roles must not
manufacture a senior one.

### B.2 The permission catalogue

Defined once in `packages/contracts/src/permissions.ts` and seeded into the
`permission` table. Adding a permission is a one-line addition plus a migration —
that is the extensibility mechanism.

```ts
export const PERMISSIONS = {
  // personnel
  'personnel.view':      { category: 'personnel', risk: 'low' },
  'personnel.create':    { category: 'personnel', risk: 'medium' },
  'personnel.edit':      { category: 'personnel', risk: 'medium' },
  'personnel.hire':      { category: 'personnel', risk: 'high' },
  'personnel.fire':      { category: 'personnel', risk: 'high' },
  'personnel.promote':   { category: 'personnel', risk: 'high' },
  'personnel.demote':    { category: 'personnel', risk: 'high' },
  'personnel.callsign':  { category: 'personnel', risk: 'low' },

  // roles
  'roles.view':   { category: 'roles', risk: 'low' },
  'roles.create': { category: 'roles', risk: 'high' },
  'roles.edit':   { category: 'roles', risk: 'high' },
  'roles.delete':  { category: 'roles', risk: 'high' },   // archives, see data-model §3a
  'roles.restore': { category: 'roles', risk: 'medium' },
  'roles.assign': { category: 'roles', risk: 'high' },

  // persons
  'persons.view':          { category: 'persons', risk: 'low' },
  'persons.create':        { category: 'persons', risk: 'low' },
  'persons.edit':          { category: 'persons', risk: 'medium' },
  'persons.delete':        { category: 'persons', risk: 'high' },   // archives
  'persons.restore':       { category: 'persons', risk: 'medium' },
  'persons.view_deleted':  { category: 'persons', risk: 'medium' },
  'persons.flags.manage':  { category: 'persons', risk: 'medium' },
  'persons.warrants.manage': { category: 'persons', risk: 'high' },
  'persons.criminal.view': { category: 'persons', risk: 'medium' },
  'persons.medical.view':  { category: 'persons', risk: 'high' },
  'persons.medical.edit':  { category: 'persons', risk: 'high' },

  // vehicles
  'vehicles.view':   { category: 'vehicles', risk: 'low' },
  'vehicles.create': { category: 'vehicles', risk: 'low' },
  'vehicles.edit':   { category: 'vehicles', risk: 'medium' },
  'vehicles.delete':  { category: 'vehicles', risk: 'high' },   // archives
  'vehicles.restore': { category: 'vehicles', risk: 'medium' },
  'vehicles.view_deleted': { category: 'vehicles', risk: 'medium' },
  'vehicles.flags.manage': { category: 'vehicles', risk: 'medium' },

  // dispatch
  'dispatch.view':   { category: 'dispatch', risk: 'low' },
  'dispatch.create': { category: 'dispatch', risk: 'low' },
  'dispatch.manage': { category: 'dispatch', risk: 'medium' },
  'dispatch.assign': { category: 'dispatch', risk: 'medium' },
  'dispatch.close':  { category: 'dispatch', risk: 'medium' },
  'dispatch.panic':  { category: 'dispatch', risk: 'low' },
  'dispatch.panic.acknowledge': { category: 'dispatch', risk: 'medium' },
  'units.manage':    { category: 'dispatch', risk: 'medium' },

  // map
  'map.view':          { category: 'map', risk: 'low' },
  'map.track_units':   { category: 'map', risk: 'medium' },
  'map.track_all_orgs':{ category: 'map', risk: 'high' },
  'map.markers.manage':{ category: 'map', risk: 'low' },
  'map.history':       { category: 'map', risk: 'high' },

  // organization
  'organization.view':     { category: 'organization', risk: 'low' },
  'organization.edit':     { category: 'organization', risk: 'high' },

  // admin — scope: 'global'
  'admin.users':         { category: 'admin', risk: 'high', scope: 'global' },
  'admin.organizations': { category: 'admin', risk: 'high', scope: 'global' },
  'admin.org_leads':     { category: 'admin', risk: 'high', scope: 'global' },
  'admin.audit_logs':    { category: 'admin', risk: 'high', scope: 'global' },
  'admin.game_servers':  { category: 'admin', risk: 'high', scope: 'global' },
  'admin.impersonate':   { category: 'admin', risk: 'high', scope: 'global' },
  'admin.purge':         { category: 'admin', risk: 'high', scope: 'global' },  // irreversible erasure
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
```

`scope: 'global'` permissions cannot be attached to an organization role. That
is what stops a PD Chief from writing themselves an `admin.users` role.

Note that the `.delete` permissions **archive** rather than erase (data model §3a).
Irreversible erasure is `admin.purge`, a separate global permission — so the
capability to remove a record permanently is never bundled into an ordinary
organizational role.

### B.3 The hierarchy rule — normative specification

> A user must never promote, demote, edit, remove, or otherwise manage someone
> whose rank is higher than **or equal to** their own.

Formally, for actor `A` and target `T` in organization `O`:

```
H1  manage(A, T)        requires  level(A, O) >  level(T, O)         [strict]
H2  assignRole(A, R, T) requires  level(A, O) >  R.hierarchy_level
H3  editRole(A, R)      requires  level(A, O) >  R.hierarchy_level
H4  grantPerm(A, P, T)  requires  P ∈ effective(A, O)                [subset]
H5  createRole(A, R)    requires  level(A, O) >  R.hierarchy_level
H6  A ≠ T for every management action, unless the action is on the
    explicit self-service allowlist
H7  every check is scoped to O; membership in another organization
    contributes nothing
```

Consequences worth stating explicitly, because each is a real attack:

- **Peer immunity.** Two Lieutenants (both level 60) cannot touch each other.
  Only a Commander can. This is why H1 uses `>` and not `≥`.
- **No self-promotion.** H6 blocks the direct route; H2 blocks the indirect one
  (assigning yourself a higher role) even if H6 were bypassed.
- **No permission manufacture.** H4 means a Sergeant with `roles.edit` can create
  a role, but only containing permissions the Sergeant already holds, at a level
  strictly below the Sergeant's own. They cannot bootstrap authority they lack.
- **No role laundering.** H3 stops "edit the Chief role to add my permissions,
  then assign it to myself".
- **No cross-org leverage.** H7 means being FIB Director grants nothing in PD.
- **Terminated members are level 0.** They can be managed by anyone with the
  permission, and they can manage no one.

Self-service allowlist (actions on oneself that are always permitted with the
relevant permission and no hierarchy check): set own duty status, join/leave a
patrol, trigger own panic, edit own account profile and password, manage own
sessions.

**Organization Lead** is level ∞ within their organization. They may manage every
member and every role of that organization, including creating roles at level 100.
They may not: touch another organization, grant global capabilities, grant
themselves or anyone else `organization_lead` (only a global admin can), or edit
any `scope: 'global'` permission assignment.

**Global admin** bypasses H1–H5 but not auditing. Every global-admin action is
written with `risk = high` metadata and can be alerted on.

### B.4 The authorization kernel

`packages/authz-core` — pure, no I/O, exhaustively unit-tested:

```ts
export interface ActorContext {
  userId: string;
  organizationId: string | null;
  isGlobalAdmin: boolean;
  isOrgLead: boolean;
  level: number;                    // effective hierarchy level
  permissions: ReadonlySet<PermissionKey>;
  globalCapabilities: ReadonlySet<GlobalCapability>;
}

export interface TargetContext {
  userId: string;
  level: number;
  isOrgLead: boolean;
  isGlobalAdmin: boolean;
}

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: DenyReason; detail?: string };

export function can(actor: ActorContext, permission: PermissionKey): boolean;
export function canManageMember(actor: ActorContext, target: TargetContext): Decision;
export function canAssignRole(actor: ActorContext, role: RoleRef): Decision;
export function canEditRole(actor: ActorContext, role: RoleRef): Decision;
export function canGrantPermissions(actor: ActorContext, keys: PermissionKey[]): Decision;
```

`apps/api/src/authz` wraps these with data loading and, critically, **transactional
evaluation**.

### B.5 Transactional evaluation (the TOCTOU problem)

Checking permissions before opening a transaction is a race. Consider:

```
t0  Sgt. A (level 50) is demoted to Officer (level 30) by the Chief
t0  Sgt. A concurrently submits "promote B to level 45"
```

If A's context was loaded before the demotion committed, a stale check approves an
action A is no longer entitled to perform. With enough concurrent requests this is
reliably exploitable, not theoretical.

Therefore every mutating operation follows this shape:

```ts
await db.transaction(async (tx) => {
  // 1. Lock the actor's membership row — serialises against any concurrent
  //    change to the actor's own roles.
  const actor = await loadActorContext(tx, userId, orgId, { lock: 'FOR UPDATE' });

  // 2. Lock the target's membership row, ordered by id to avoid deadlock.
  const target = await loadTargetContext(tx, targetId, { lock: 'FOR UPDATE' });

  // 3. Decide, inside the transaction, on freshly read state.
  const decision = canManageMember(actor, target);
  if (!decision.allowed) throw new ForbiddenError(decision);

  // 4. Mutate.
  await tx.update(memberRole)...;

  // 5. Audit in the same transaction — the record cannot diverge from the change.
  await writeAudit(tx, { ... });
});
```

Rules that fall out of this:
- Row locks are always acquired in ascending `id` order to prevent deadlocks
  between two symmetric operations.
- Isolation level `READ COMMITTED` is sufficient given explicit `FOR UPDATE`;
  `SERIALIZABLE` is reserved for the few multi-row invariants that need it.
- The audit write shares the transaction. A rolled-back change leaves no audit
  row, and a committed change always leaves one.

### B.6 Permission caching

Per-request memoisation, plus a Redis cache keyed
`authz:{userId}:{orgId}:v{permissionVersion}` with a 60 s TTL.

`permissionVersion` is a counter bumped whenever anything that could affect a
user's effective permissions changes (role edit, role assignment, override,
membership status, org-lead grant). Bumping the version invalidates the cache by
changing the key rather than by deleting entries, which is race-free.

**The cache is never used for authorization decisions in a write transaction.**
It exists to make read-heavy navigation and list filtering cheap. Writes always
re-read under lock. This distinction is load-bearing and must be enforced by code
review: `loadActorContext` takes an explicit `{ lock }` argument and the cached
path is a different function name.

### B.7 Enforcement layering

| Layer | Role | Trusted? |
| --- | --- | --- |
| UI navigation and buttons | hide what the user cannot do | No — cosmetic only |
| Next.js Server Components | avoid rendering data the user cannot see | Partially — still re-checked by API |
| API route guard | coarse `requirePermission('x')` on the route | Yes |
| Domain service | fine-grained hierarchy checks inside the transaction | **Yes — the real boundary** |
| Database constraints | structural invariants | Yes — last line of defence |

A route guard alone is never sufficient for a personnel or role operation, because
the guard cannot know the target's rank. The domain service is the authority.

### B.8 Error semantics

- Missing permission on an object the actor cannot even see → `404`. Returning
  `403` would confirm the resource exists.
- Permission held but hierarchy rule violated → `403` with a machine-readable
  `reason` (`TARGET_RANK_NOT_LOWER`, `ROLE_LEVEL_TOO_HIGH`,
  `PERMISSION_NOT_HELD_BY_ACTOR`, `CROSS_ORGANIZATION`, `SELF_ACTION_FORBIDDEN`)
  so the UI can explain the refusal precisely.
- Every denial is audited with `outcome = 'denied'`.

### B.9 Test obligations

The authz kernel does not ship without:
1. A table-driven matrix over every (actor level, target level, permission set)
   combination for each management action.
2. Property tests asserting the invariants: no operation ever produces an actor
   with permissions exceeding their pre-operation set; no operation ever raises a
   target to a level ≥ the actor's.
3. Concurrency tests against real Postgres (Testcontainers) that run demotion and
   promotion simultaneously and assert no interleaving grants escalated privilege.
4. Explicit regression cases for each attack in §B.3.

**Status.** Obligations 1, 2 and 4 are met for personnel management by
`packages/authz-core/test/decisions.test.ts` (the matrix and the property tests)
and `apps/api/test/personnel.test.ts` (the attacks, exercised through the HTTP
surface against real Postgres). Obligation 3 is met by the TOCTOU case at the end
of that file, which sequences the race deterministically — it holds a lock on the
actor's membership row while their own promotion request is in flight, demotes
them, and asserts the request is then decided on the rank they actually hold. The
same obligations still apply to role mutations, which are not yet built.

Role mutations are covered by `apps/api/test/roles.test.ts`, which adds the
hierarchy cases specific to editing the structure itself: creating a role at or
above the actor's own level, lifting a role the actor may edit above themselves,
dragging a role from above the actor down, reordering as a batch (refused whole
when any single entry reaches too far), archiving and restoring, and the full
escalation chain walked end to end as one actor and as an accomplice pair. Its
own TOCTOU case demotes the actor while their role edit waits on the lock.

**H5b — moving a role is bounded at BOTH ends.** `canMoveRole` checks the role's
current level and its destination. Checking only the origin lets a Lieutenant
take the Sergeant role, which they may edit, and lift it to L90 — manufacturing a
rank above themselves to be promoted into. Checking only the destination lets
them reach up to the Chief role and drag it down. Reordering is the operation
where a single-ended check is a hole, so the batch endpoint applies the same
two-ended rule per entry and is all-or-nothing.

**The shared registers are gated by PERMISSION, not by organization scope.**
Persons and vehicles are not owned by a department — a citizen record scoped per
organization would mean six copies of the same person, and a plate is looked up
by whoever stops the car. This is where "some organizations have broader access
than others" is actually implemented, and it needs no organization-specific code:
PD's field bundle carries `persons.criminal.view` and not
`persons.medical.view`, MD's medical bundle the reverse. A withheld section is
NOT LOADED, not loaded-and-trimmed — a field removed at the DTO boundary has
still left the database.

Two pieces inside those registers are scoped, because the DATA is
organization-owned rather than the actor: a warrant belongs to the organization
that issued it (so another organization may SERVE it but not REVOKE it — a
shared wanted list is useless if only one department can close a case, and
dangerous if any department can quietly cancel another's), and a fleet vehicle
belongs to the organization that operates it (so another organization may FLAG it
but not edit or archive it — reporting a vehicle stolen is exactly what the
shared register is for).

**GLOBAL SEARCH IS THE EASIEST PLACE IN THE SYSTEM TO LEAK SOMETHING** — one
screen that touches every table at once, where a category nobody remembered to
filter turns the search box into a way to enumerate records the operator could
not open directly. The reach is therefore resolved ONCE, in
`modules/search/search.scope.ts`, and every category query takes it as an
argument rather than deciding for itself. Three rules hold there:

- a category is gated by the SAME permission that gates its own screen — search
  must never be a second, weaker door into the same data;
- a category the caller may not read is NOT QUERIED, not queried-and-filtered
  and not returned empty. An empty result set still says "this category exists
  and you matched nothing", which is a different statement from "you cannot
  search this";
- COUNTS ARE FILTERED TOO. "MD personnel: 42" leaks the size of another
  organization's roster as surely as listing them would.

A search that matched something is audited with the term and the per-category
counts — never the matched records, which would make the audit table a second
copy of the register. A search that matched nothing is not logged: it says
nothing about anyone, and logging every keystroke pause would bury the entries
that matter.

**Sensitive READS are audited.** Misuse of a police or medical database is
overwhelmingly a read problem, and the audit trail is the only thing that makes
it answerable afterwards. Opening a person record, a medical record or a plate
writes an audit row naming the reader. Medical CONTENT is never copied into that
row: recording who looked is oversight, copying the diagnosis into a table read
under a different permission would defeat gating the record at all.

**The subset rule is asymmetric, deliberately.** Adding a permission to a role
requires the actor to hold it (H4). Removing one does not: removal cannot raise
anyone's authority, and requiring the permission in order to remove it would
strand a role that drifted above its editor. Both directions remain bounded by
H3 and both are audited.

One kernel correction came out of writing these tests. `can()` consulted only the
actor's explicit permission set, so an Organization Lead whose nominal role was a
low one held no permissions at all — while `canManageMember`, `canAssignRole` and
`canGrantPermissions` all already treated a lead as unbounded within their
organization. `can()` now agrees with them, and excludes global-scope permissions
so the capability cannot become an administrative one.

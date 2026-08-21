# 11 — Global Administration

The administration panel is the one place in LEOOS where a single request can
change who can do anything. This document records the boundaries it defends and
why they are drawn where they are.

---

## 1. The property everything here exists to protect

**An Organization Lead is not an administrator.**

A lead is unbounded inside their own organization: they can hire, fire, promote
to any rank, write any organization role and set any permission on it. None of
that reaches the administration area, and the reason is structural rather than a
check somebody remembered to write.

| Mechanism | Where |
| --- | --- |
| Global capabilities live in `user_global_role` — a table no organization operation writes to. | [data-model §3](01-data-model.md) |
| `can()` excludes global-scope permission keys from a lead's implicit grant, so `admin.users` is not conferred by leading an organization. | `packages/authz-core/src/decisions.ts` |
| `canGrantPermissions` refuses to attach a global-scope permission to an organization role. | same |
| A database trigger refuses it again, so a direct `INSERT` cannot do what the API will not. | `role_permission_scope_check` |
| Every admin decision reads `globalCapabilities`, never `permissions`. | `packages/authz-core/src/admin-decisions.ts` |

There is therefore no sequence of organization-level actions that produces a
global capability. A lead editing roles all day converges on "unbounded in one
organization" and stops.

This is asserted three ways: over the whole permission catalogue in the kernel
tests, against every administration endpoint in `apps/api/test/admin.test.ts`,
and in a real browser in `apps/web/scripts/admin-check.mjs`, where the PD Chief
sees no administration navigation and every hand-typed URL sends them away.

---

## 2. The five capabilities

Deliberately five separate grants rather than one "admin" flag with levels.
Levels imply nesting, and these do not nest: an `audit_viewer` must be able to
review what a `user_admin` did without being able to do it.

| Capability | Reads | Changes |
| --- | --- | --- |
| `global_admin` | everything | everything — and is the only capability that can grant capabilities |
| `user_admin` | the account register, account detail | account status |
| `org_admin` | organizations, leads, the permission overview | organizations, lead appointments |
| `audit_viewer` | the audit log, the permission overview | nothing |
| `support` | account detail | nothing |

`support` and `audit_viewer` are read-only by construction, not by convention:
they appear in no decision that authorizes a mutation.

### Why granting is not delegable

Only a `global_admin` may grant or revoke a capability. If `user_admin` could
grant capabilities it could grant itself `global_admin`, and the distinction
between the two would last exactly one request (engineering rule 12). The same
reasoning already governs the Organization Lead grant, for the same reason.

A `user_admin` also may not change a **global administrator's** account status.
Otherwise the lesser capability contains the greater one in the only sense that
matters operationally: it could disable every administrator and be the last
person able to act.

---

## 3. The installation cannot be locked out

Two operations can make LEOOS unadministrable, and neither is recoverable from
inside the application, because a capability can only be granted by somebody who
already holds it:

- disabling or suspending the **last enabled global administrator**;
- revoking the **last `global_admin` grant**.

Both are refused, and so is any change an administrator makes to **their own**
account status or `global_admin` grant. That last rule is not paternalism: the
failure is silent — the request succeeds and only the next page load reveals the
lockout — and it is the shape a confused-deputy attack takes.

**The guard holds under concurrency.** "Is this the last administrator" is a
read-decide-write, so the count runs inside the same transaction that performs
the change, after a `SELECT … FOR UPDATE` on the target. Two administrators
disabling each other simultaneously would otherwise each read one remaining and
both succeed, leaving zero.

Reinstating is deliberately *not* guarded by the count: the rule is about
removing the last way in, so it must never block the operation that adds one.

---

## 4. Account status

Four states, and `suspended` is kept distinct from `disabled` on purpose:
suspension is a temporary measure taken during an investigation, disabling is
the end of an account's working life, and an administrator reviewing the register
a month later needs to know which decision was made.

Deactivating an account **revokes every session immediately** and bumps the
permission version. A suspension that leaves somebody signed in until their
cookie expires is not a suspension.

`pending_verification` is not settable. It is a state the registration flow
produces, and pushing an account back into it would invent a verification that
never expired. Re-activating an account that never verified its address is
refused with a sentence — a database `CHECK` forbids it too, but a constraint
violation surfaces as a 500 with a Postgres error string, which is safe and
operationally useless.

---

## 5. The audit log

### Severity is derived, not stored

The audit table has no severity column, and adding one would mean back-filling
every existing row with a guess. Severity is computed from two things the row
already carries — what the action is, and whether it succeeded:

| | Meaning |
| --- | --- |
| `critical` | a refused privileged action, or a successful purge |
| `high` | a privilege, account or organization change that succeeded; any error |
| `notice` | an ordinary operational change |
| `info` | a read, a sign-in, routine traffic |

A **refusal outranks the same action succeeding**: somebody attempting what they
do not hold is the signal an operations lead is scanning for.

Because it is derived, the severity of a row can always be recomputed from the
row, so it cannot drift from what actually happened (engineering rule 34).

**The rule exists twice** — as a SQL predicate for the filter and as TypeScript
for the label — because filtering by severity has to search the whole table, not
the page that happened to load. Two implementations of one rule are exactly the
pair that drifts, and the drift here is silent: rows vanish from a filtered view
and it looks like a quiet week. A release-gate test runs both across every action
in the catalogue and asserts they select the same rows.

### Paging is a keyset, not an offset

The log grows at the head while somebody reads it. `OFFSET 200` re-counts from a
list that has shifted underneath the reader, silently repeating rows from the
previous page and skipping others. The cursor is `(occurred_at, id)` — a position
in the data rather than a distance from a moving edge.

### The count is bounded

`count(*)` over an append-only table that only grows is a sequential scan for a
number that is stale before it renders. Past a ceiling the API reports the bound
it actually checked and says so, rather than a figure it did not compute.

### Metadata is passed through, not summarised

The metadata of a role change and of a panic have nothing in common. One
formatter over both would end up describing one of them wrongly, so the screen
shows the keys and lets the reader read them.

---

## 6. System configuration is read-only

"System configuration where appropriate" — the appropriate part is *reporting*
it. Editing a deployment's configuration from inside the application it
configures is a bootstrapping problem wearing a feature's clothes: the database
URL and the signing keys have to be right before the process can serve the screen
that would edit them. And a setting changeable from a browser is a setting an
attacker with a session can change.

So the screen answers "what is in force", names where each value comes from, and
stops. Every component reports the state it **has** — an adapter behind a mock
says `mock` in the same words the boot log uses, never a green light it has not
earned (engineering rules 35, 45). Today that means the screen says, in plain
words, that password-reset email is being written to a log file and not
delivered.

---

## 7. No credential can leave the process

The administration surface reads the most sensitive table in the system.
`user_account` carries `password_hash`, `totp_secret_enc` and the login-failure
counters, and a DTO assembled by spreading that row would leak all three the day
somebody adds a column.

Three walls:

1. **The queries name their columns.** No `select()` without an argument appears
   anywhere in `apps/api/src/modules/admin/`.
2. **The DTOs have nowhere to put a credential.** Every response type names its
   fields one by one; there is no index signature and no function spreads its
   input.
3. **A test proves it.** `admin.test.ts › no admin response carries a credential`
   serialises every endpoint's output and searches it for `passwordHash`,
   `password_hash`, `tokenHash`, `secretHash`, `totpSecret` and the `$argon2`
   prefix. The browser walkthrough repeats the search over the rendered HTML of
   every screen.

`failedLoginCount` is withheld too. It tells an administrator nothing they can
act on and nudges towards treating a number of failures as evidence; whether the
account is *currently* locked is the actionable fact, and that is reported.

---

## 8. Where authorization is decided

Every route decides for itself, using the same functions the UI's capability
block is built from. There is deliberately **no blanket prefix guard** beyond
requiring a session:

- a prefix-wide "must be an administrator" hook silently stops matching when
  somebody adds a route with a slightly different path;
- it flattens five capabilities into one, so an `audit_viewer` would either reach
  the account register or be locked out of the log they exist to read.

The page-level guard in `apps/web/app/(app)/admin/guard.tsx` is a **redirect, not
a boundary**. It exists so an operator arriving from a stale bookmark is sent
somewhere useful instead of a wall of refusals. Every endpoint behind those
screens re-decides authorization for itself.

Navigation is filtered on the server from **two** kinds of authority: an
organization permission reveals the operational screens, a global capability
reveals the administration ones. Filtering on permissions alone would hide the
account register from a `user_admin`, who holds no organization permission at
all — which is precisely the person it exists for.

---

## 9. What is tested

| Property | Where |
| --- | --- |
| An org lead reaches no administration decision, over the whole permission catalogue | `packages/authz-core/test/admin-decisions.test.ts` |
| An org lead is refused by every administration endpoint | `apps/api/test/admin.test.ts` |
| A `user_admin` cannot grant any capability, or disable a global admin | same |
| Self-action and last-administrator lockouts are refused | both |
| Disabling revokes sessions, blocks sign-in and audits with the reason | `apps/api/test/admin.test.ts` |
| A refused grant is audited as `denied`, not silently dropped | same |
| The severity filter and the severity label agree for every action | same |
| Keyset paging never repeats or skips a row | same |
| No response and no rendered page carries a credential | API test + browser walkthrough |
| The whole panel, in a browser, as five different actors | `apps/web/scripts/admin-check.mjs` |

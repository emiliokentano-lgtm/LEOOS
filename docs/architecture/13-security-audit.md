# 13 — Security audit

A adversarial review of the whole application: authentication, authorization,
hierarchy, the FiveM ingest, data exposure and the audit trail. This document
records what was found, why it was reachable, and what now stops it.

Every finding below was **confirmed against a running system** before it was
fixed, and every fix has a regression test that fails without it.

---

## Findings

| # | Severity | Issue | Fixed in |
| --- | --- | --- | --- |
| F1 | **High** | A terminated or suspended member who still held an Organization Lead grant kept read access to the organization | `context.service.ts`, `decisions.ts` |
| F2 | **High** | A WebSocket connection survived logout, session revocation, password change and account disabling | `session.service.ts`, `hub.ts`, `plugins/realtime.ts` |
| F3 | Medium | Any organization could rewrite or close a multi-agency incident it had nothing to do with | `incident.service.ts` |
| F4 | Medium | The FiveM replay-protection store was written to *before* the signature was checked, and was unbounded | `fivem.auth.ts`, `nonce-store.ts` |
| F5 | Medium | `TRUNCATE audit_log` succeeded — the append-only trigger does not cover TRUNCATE | migration `0009` |
| F6 | Low | Login attempts against a locked account were not audited | `auth.service.ts` |
| F7 | Low | `INTERNAL_API_TOKEN` — a complete CSRF bypass — had no production strength check | `config.ts` |

---

## F1 — A lead grant outlived the membership it led

**Severity: High.** Read access to an organization's entire roster, unit list
and vehicle fleet, by somebody it had just fired.

**Cause.** `organization_lead` and `organization_member.status` are separate rows
changed by separate operations. Firing somebody does not revoke their lead
grant — reasonably, because the two are different facts. But `toActorContext`
built the authorization context from the grant alone:

```ts
const isOrgLead = membership?.isOrgLead ?? false;
const level = isGlobalAdmin || isOrgLead ? UNBOUNDED_LEVEL : …;
```

so a terminated chief arrived at every decision as an unbounded organization
lead. The kernel's `can()` and every *mutating* decision guard on
`membershipActive`, which is why this was a read exposure and not a write one —
but the three organization **view** decisions read `isOrgLead` directly and did
not, so:

```
GET /api/v1/organizations/:id            200
GET /api/v1/organizations/:id/members    200
GET /api/v1/organizations/:id/units      200
GET /api/v1/organizations/:id/vehicles   200
GET /api/v1/organizations/:id/personnel  200
GET /api/v1/organizations/:id/roles      200
GET /api/v1/organizations/:id/leads      200
```

**Fix.** Two locks on the same door.

1. The context no longer asserts what it cannot support: an inactive membership
   confers neither `isOrgLead` nor a hierarchy level. This is the root cause, and
   it fixes every consumer at once — including `role.dto.ts` and
   `personnel.dto.ts`, which read `actor.isOrgLead` directly to decide what a
   viewer may see.
2. `canViewOrganization`, `canViewOrganizationSection` and
   `canViewOrganizationLeads` now check `membershipActive`, matching
   `canEditOrganization`, which always did. A read decision that trusts its input
   is one refactor away from being wrong again.

The refusal reason is `NO_ACTIVE_MEMBERSHIP`, not a missing permission: a fired
chief should not be sent to ask for `organization.view`.

**Regression test.** `apps/api/test/security.test.ts` §F1 sweeps all seven
endpoints for a terminated lead and again for a suspended one, asserts the write
side stays closed, and asserts an **active** lead still gets 200 on all seven —
a fix that quietly broke the legitimate flow would otherwise pass.
`packages/authz-core/test/decisions.test.ts` asserts it over every decision in
the kernel, so a new one that forgets the guard fails there first.

---

## F2 — A socket outlived its session

**Severity: High.** Live officer positions and panic alerts kept streaming to a
disabled account.

**Cause.** ADR-0004 chose opaque, server-side, instantly revocable sessions
precisely so that "when someone is fired, access must end NOW". Every HTTP
request re-proves its session. A WebSocket authenticates **once**, with a
single-use ticket, and then holds only a session id — and nothing on that path
ever looked at it again. `resolveActor` re-read *permissions* on every delivery,
which is why a demotion took effect immediately, but a revoked session resolves a
perfectly good permission set.

`RealtimeHub.closeSession` and `TicketStore.revokeSession` existed and **nothing
called them**. The ticket module's own comment claimed "revoking the session
kills every connection it authorised"; it did not.

So logging out, revoking a session, changing a password, or disabling an account
all left the socket open until the process restarted — while every HTTP request
from the same person was correctly refused.

**Fix.** Session liveness became part of what is re-read, which is the shape the
subsystem already used for permissions ("nothing is cached to revoke").

- `isSessionLive(db, sessionId)` applies the same rules as `resolveSession`, in
  the same order, keyed by id instead of by token: revoked, expired, superseded
  by a password change, or attached to a non-active account.
- The hub checks it on every `subscribe` and every `deliver`, and **closes** the
  socket rather than merely unsubscribing it.
- A sweep on the existing heartbeat catches map-only subscribers, which receive
  position batches through a synchronous path and no events at all — precisely
  the connection least acceptable to leave open.
- Cached for one second, so a burst of events does not run the query per event
  per subscriber. That second is the worst-case latency between a revocation and
  the socket closing, and the tests assert it explicitly rather than sleeping
  past a flake.

**Regression test.** §F2 opens a real connection on a real session and kills it
four ways — revocation, delivery-time revocation, account disabling, password
change — asserting the socket is closed with code 4001 each time, and that a live
session still subscribes normally.

---

## F3 — A joint call was writable by everyone

**Severity: Medium.** Cross-organization write.

**Cause.** A multi-agency incident has `organization_id IS NULL`, so the
ownership check that guards every other incident had nothing to compare against:

```ts
if (!scope.canViewAllOrganizations && row.organization_id !== null) { … }
```

For reads that is deliberate and stays — a joint call belongs on the board of
every service that might have to work it. For **writes** it meant an MD doctor
with no unit on a PD/FIB joint operation could add notes to it, downgrade its
priority, and close it. Confirmed: `note 201, priority 200, close 200`.

**Fix.** `lockIncident` takes an `intent`. Visible is not the same as writable: a
mutation on an unowned incident now requires either cross-organization clearance
or that one of the actor's organizations has a unit **currently assigned** — the
same "involved organizations" set the event topics and the notification audience
are already derived from, so all three now agree.

Assigning a unit is deliberately exempt: it is how an organization *joins* a
joint call, and requiring prior involvement would make a multi-agency incident
permanently unresponable. The unit is validated against the actor's own
organization there, which is the check that matters.

**Regression test.** §F3 asserts the read still works, the five mutations are
refused, the same organization becomes able to write **after** assigning a unit,
and single-agency scoping is unchanged.

---

## F4 — Replay protection could be poisoned without a signature

**Severity: Medium.** Unauthenticated denial of service against a game server's
telemetry.

**Cause.** The ingest checks ran cheapest-first, with the nonce at position 5 and
the HMAC at 7. That principle is right for checks and wrong for a check that
**writes**: `remember` inserts.

The key id is a header, not a secret — it identifies the credential and proves
nothing. So anyone who had seen one could, with no valid signature:

- insert unlimited entries into the in-process nonce store, which was
  **unbounded** — a memory-exhaustion primitive requiring no credential;
- **pre-burn** the nonce of a request they could observe, so the genuine request
  was then refused as `replayed-nonce`.

Rate limiting did not help: it is applied per credential *after* this function
returns, so it never saw these requests.

**Fix.** The nonce is consumed last, after the HMAC verifies, so only something
holding the secret can insert — and those requests are rate limited. Nothing is
given up: an authentic replay still arrives with an authentic signature and is
still refused, which is what the nonce is for. The store is additionally bounded
at 100 000 entries, reclaimed in batches so the memory bound cannot become a CPU
one.

**Regression test.** `apps/api/test/fivem.test.ts` sends a forged request using
the nonce a genuine request is about to use, then sends the genuine request and
requires it to succeed. Against the old code the genuine request returns
`FIVEM_REPLAYED_NONCE`. A second test proves a real replay is still refused.

---

## F5 — The audit log could be erased in one statement

**Severity: Medium.** Destruction of the legal record.

**Cause.** `audit_log`, `incident_log` and `member_status_history` have been
append-only since migration 0001, enforced by a trigger on `UPDATE OR DELETE`.
**TRUNCATE fires neither**: it is its own statement type with its own trigger
event. `TRUNCATE audit_log;` succeeded.

The `REVOKE` beside the trigger was the only obstacle, and it is wrapped in a
role check that silently does nothing unless the application connects as a role
named `leoos_app` — a deployment detail, not a guarantee.

**Fix.** `BEFORE TRUNCATE` triggers on all three tables (migration 0009).
Bypassing it now requires disabling a trigger, which requires table ownership or
superuser: a deliberate, auditable act at the database level rather than one
stray statement from the application.

**Regression test.** §F5 asserts TRUNCATE, DELETE and UPDATE are all refused on
all three tables, reading the reason out of the driver's cause chain rather than
the wrapper — a test that matched the wrapper would pass for a typo.

---

## F6 — An attack went dark once the lockout engaged

**Severity: Low.** Loss of the signal the audit log exists to carry.

**Cause.** Every refusal on the login path wrote an audit row except one: the
branch that runs while an account is locked returned silently. The lockout
engages after `LOGIN_MAX_ATTEMPTS`, so the log went quiet at exactly the moment
it became interesting — the continued attempts *after* the lock are what
distinguish a forgetful user from somebody working through a password list.

**Fix.** That branch writes `LOGIN_FAILED` with `reason: 'account_locked'`.

**Regression test.** §F6 locks an account, makes three attempts with the
**correct** password, and asserts three audit rows with that reason.

---

## F7 — A documented CSRF bypass could reach production

**Severity: Low** in isolation, **High** if it ships.

**Cause.** `plugins/auth.ts` exempts any request carrying `INTERNAL_API_TOKEN`
from the origin check and the CSRF double-submit — correctly, because the web
tier is not a browser. The consequence is that whoever knows the string can make
state-changing requests from anywhere. The schema's `min(16)` accepted the value
printed in `.env.example` (`change-me-at-least-16-chars`, 27 characters), so an
installation that copied the example and never read it shipped with a publicly
documented bypass.

**Fix.** Production refuses a token under 32 characters or matching a placeholder
pattern, with a message that includes the command to generate a real one.
Development is untouched. The comparison is also now constant-time — it is a
secret, and secrets are not compared with `===`.

**Regression test.** §F7 asserts both refusals, that a real token is accepted,
and that development still starts with the placeholder.

---

## What was examined and found sound

Recorded so the next audit knows what has already been walked.

| Area | Verdict |
| --- | --- |
| Login | Dummy-hash timing equalisation, lockout, audit on every outcome, status checked **after** credentials so it is not an account oracle |
| Registration | Identical response and comparable timing for a taken address; username charset excludes `@`, so a username cannot shadow an email at login |
| Sessions | Opaque, hashed at rest, rotated on login (no fixation), sliding window capped by an absolute lifetime, invalidated by password change |
| Password reset | 256-bit tokens stored as SHA-256, single-use under concurrency, every session revoked on use, no enumeration in the response |
| Email verification | Activation scoped to `pending_verification`, so a stale token cannot reactivate a disabled account |
| Hierarchy H1–H7 | Strict `>` throughout; both ends checked on a role move; removals exempt from the subset rule and additions not |
| Cross-org role assignment | Refused even for a global administrator — the role must belong to the target's organization |
| Organization Lead | Cannot appoint another lead, cannot reach any global capability, refused by a DB trigger as well as by the kernel |
| Admin surface | Each route asks its own question; no blanket prefix guard; every refusal audited |
| FiveM payloads | No field for an organization, rank or callsign; `.strict()` schemas; every organizational fact resolved from the database |
| Map | Covert units filtered in SQL before serialisation; absent from the payload rather than flagged |
| Search | Every category gated by the permission that gates its own screen; counts filtered too |
| Notifications | Feed scoped to the caller in SQL with no parameter; `user:<id>` refused to everyone else on every delivery |
| Error responses | Stable codes and chosen messages; internal reasons logged, never returned |
| Open redirect | `/api/session/expired` accepts only a same-site path |
| Audit coverage | Every security-sensitive action, and every **refusal**, in the same transaction as the change |

---

## Accepted, with reasons

- **Per-identifier login throttling is keyed on the identifier as typed**, so
  alternating username and email doubles the allowance from 5 to 10 per 15
  minutes. The per-IP limit (30) and the account lockout both still apply, and
  keying on the resolved account would require a lookup before the limiter —
  which is the amplification the limiter exists to prevent.
- **`/verify` and `/password/reset` are not rate limited.** Both take 256-bit
  tokens, so guessing is infeasible, and neither performs expensive work before
  the token is validated — a garbage token returns before Argon2 is reached.
- **Multi-agency incidents remain readable by every organization.** That is the
  point of a joint call; F3 closed the write side only.
- **The nonce store, ticket store and actor cache are in-process.** Documented
  since the real-time phase: this is single-node until Redis is provisioned, and
  the persisted sequence counter is what holds under horizontal scale.

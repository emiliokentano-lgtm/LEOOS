# 15 — Testing

What is tested, where, and what is deliberately not. This document is the map;
the tests themselves carry the reasoning for each individual case.

The suite is a **release gate**, not a report card: a change that breaks it is
not finished. Nothing here is skipped, marked `todo`, or weakened to pass — where
a property could not be tested, it is written down in
[§7](#7-remaining-risks) rather than papered over with a test that cannot fail.

---

## 1 — The shape of the suite

| Package | Files | Tests | What it holds |
| --- | ---: | ---: | --- |
| `packages/contracts` | 6 | 116 | Pure domain logic: coordinates, projection, incident transitions, filters, clustering, dashboard metrics |
| `packages/authz-core` | 2 | 116 | The authorization kernel: hierarchy rules H1–H8, role mutation, global administration |
| `packages/db` | 3 | 41 | Schema, constraints and the invariants the database enforces itself |
| `apps/api` | 20 | 655 | Every HTTP surface, the real-time hub, the FiveM ingest and its command channel, and the security regressions |
| **Total** | **31** | **928** | |

Plus **13 browser walkthroughs** in `apps/web/scripts`, which drive a real
Chromium against running servers and assert on what an operator actually sees.

The API suite runs with `fileParallelism: false` against one Postgres database.
That is deliberate — see [§6](#6-what-the-shared-database-costs).

---

## 2 — Unit level

**Permission calculation** (`authz-core`). Effective set is role grants ∪ explicit
grants − explicit denies, with deny winning. Tested as properties, not examples:
combining roles never produces a level above the highest single role, never
manufactures a permission no contributing role carried, and is order-independent.

**Hierarchy** (`authz-core`). H1 (strictly-greater-than, so peers are mutually
immune) is checked exhaustively across the whole level matrix rather than at a
few points. H6 (no self-management) and H7 (organization scope) have their own
blocks, and two property tests assert that *no* operation and *no* role mutation
can ever escalate the actor.

**Organization scoping** (`authz-core` + `apps/api`). At the kernel as H7, and at
every HTTP surface as a 404 rather than a 403 — out of scope must not confirm
that the resource exists.

**Authentication** (`apps/api/test/auth.test.ts`). Registration, verification,
login, lockout, sessions, password change and reset, account disabling. The
refusal for a wrong password and for an unknown account are asserted to be
byte-identical apart from the request id.

**Incident state transitions** (`contracts`). The transition table is checked
against itself: closed and cancelled are terminal, no status transitions to
itself, every status in the table is reachable from the initial one, and the
table only ever names real statuses.

**Unit status transitions** (`apps/api/test/dispatch.test.ts`). Statuses are a
*table*, not an enum, so what is tested is that the catalogue is honoured: a key
outside it is refused, `panic` cannot be set as a plain status change, and a
member's status carries to the unit they crew. `POST /units/:id/status` — a
dispatcher marking a car out of service — is gated on `units.manage` where the
self endpoint is gated on nothing but an active membership; the two are adjacent
in the routes file, which is exactly why both are tested.

**Coordinate validation** (`contracts/test/geo.test.ts`). World bounds, clamping
(a bad sample is clamped, never a reason to lose the unit), the world ↔ map-plane
round trip, distance, heading wrap-around, and the Leaflet CRS agreeing with the
plane it is derived from.

**Role assignment** (`authz-core`, `apps/api/test/roles.test.ts`). Assignment,
level moves, deletion, permission edits — each refused above the actor's own
rank, and each tested from both directions.

---

## 3 — Integration

`apps/api/test/lifecycle.test.ts` walks the **entire lifecycle in order**, through
the HTTP surface only:

```
register → verify → login → create organization → create roles → set permissions
  → hire → assign role → promote → demote → hire the lead → appoint the lead
  → go on duty → crew a unit → file an incident → assign the unit
  → position arrives → panic → acknowledge → stand down → close
  → terminate → archive the organization
```

The other suites are organised by module and build their state with direct SQL,
which is right for testing a module: a scoping test must be able to create the
state it then proves is refused, without depending on the endpoint that produces
it. It also means nothing was checking that the endpoints **compose**. This file
uses no fixture shortcuts after the first global administrator.

It found three things a per-module suite could not:

1. **A lead grant requires a membership**, and the API refuses it at the front
   door — so the walk's original ordering (appoint, then hire) was wrong. That
   refusal is now asserted, because it is the front-door form of the F1 security
   finding.
2. **Termination revokes every session**, so the next request is 401 rather than
   404. The test asserts the stronger behaviour it found rather than the weaker
   one it expected.
3. **Archiving an organization with staff answered 500** — see
   [§5](#5-what-this-phase-found).

---

## 4 — By area

### Authorization

Unauthorized behaviour is tested explicitly and beside its allowed twin, so a fix
that quietly broke the legitimate flow cannot pass. Ten named hierarchy attacks
have their own block in `security.test.ts`; the kernel's own suite covers the
matrix.

A Lead reaches **no** global administration, and not by a check: capabilities
live in a table no organization operation writes to, `can()` excludes
global-scope keys from a lead's implicit grant, and both `canGrantPermissions`
and a database trigger refuse to attach one to an organization role. Asserted
over the whole catalogue rather than a sample.

### Real time

Topic parsing, subscribe-time authorization and delivery-time **re**-authorization
(a demoted operator stops receiving on the next event, not on their next
reconnect). Added this phase, in `connection lifecycle`:

- a removed connection stops receiving, and nothing is written to its socket;
- removing twice is a no-op — a client close, a heartbeat sweep and a session
  revocation can all land on the same connection;
- a reconnecting client's subscribe reply carries the **current** sequence, not
  zero, so it can tell it missed events while away;
- sequences are strictly monotonic across 25 publishes, and a topic is not
  renumbered when a second subscriber joins — two dispatchers must be able to
  say "event 7" and mean the same event;
- subscribing twice does not double-deliver, which for a panic would be a second
  alert for an emergency already being handled;
- unsubscribing stops delivery without closing the connection;
- ten rapid positions for one unit coalesce to the **latest**, not the first.

Out-of-order delivery does not arise on a single topic — the hub numbers events
itself and a socket is ordered — so what is tested is the gap detection a client
uses after a reconnect, and the coalescing where staleness genuinely can occur.

### FiveM

Signature, tampering, replay, sequence, clock skew, revocation, protocol version,
and the forge-an-organization attempt. Added this phase:

- **excessive request rate** — refused past the per-credential limit; one game
  server's traffic does not spend another's budget (same address, different
  credential); and each surface has its own bucket, so a heartbeat storm does not
  blind dispatch by exhausting telemetry;
- **a player crewing no unit** — the middle case between an unlinked stranger and
  an officer in a car. Accepted, because it is completely ordinary, and attributed
  to nothing: no position enters the store and no unit is invented to hang it on.

### UI

Thirteen Chromium walkthroughs, each asserting on rendered output and failing on
console errors, page errors and horizontal body overflow:

`session` · `records` · `search` · `personnel` · `roles` · `map` · `dashboard` ·
`dispatch` · `notification` · `admin` · `realtime` · `fivem` · `live-map` ·
`visual`

Loading, empty, error and permission states are covered inside the relevant
walkthrough — the notification check asserts that an officer without the
permission is *told so and offered no form*, the dashboard check asserts an
unmeasured metric is explained in words rather than rendered as zero.

`visual-check` screenshots every screen at **four viewports** — 1920×1080,
1440×900, 1280×800 and 1024×768 — and fails on horizontal body scroll at any of
them. The two narrower ones were added this phase because the shell already
contained breakpoint logic (`top-bar.tsx` hides the organization label below
`lg`) that nothing was exercising. 1024 is the floor deliberately: this is a
seated dispatcher's console, and claiming a phone layout the product does not
have would be worse than not claiming one.

#### The cast is provisioned, not assumed

Nine of the walkthroughs sign in as a fixed name — `ui.admin`, `ui.chief`,
`ui.commander`, `ui.sergeant`, `ui.officer1`, `ui.cadet1`, `ui.medic` — because a
screenshot comparison wants the same account every run. For a long time nothing
in the repository created them: they existed in one developer's database, and a
clean checkout got a `waitForURL` timeout at the login form with no explanation.

`packages/db/scripts/setup-ui-cast.mjs` now creates them, idempotently, and
**repairs** them — a rerun after the admin walkthrough disabled an account puts
it back, which is the failure mode that would otherwise return. It refuses a
production database, and it copies a password hash the API has already verified
rather than writing one, so a change to the Argon2 parameters cannot leave it
minting logins that do not work.

The other three casts (`setup-admin`, `setup-notifications`, `setup-live-map`)
are tagged per run and print `export` lines to source.

---

## 5 — What this phase found

Three defects, each confirmed against a running system and each with a
regression test verified to fail against the pre-fix code.

### T1 — An unconfigured ingest key answered 500

**Severity: low** (operability). An installation without
`LEOOS_FIVEM_SECRET_KEY` answered "issue a game-server credential" with a bare
500 and logged `unhandled error`. The exception carried a perfectly good
explanation — which variable is missing, and the command to generate one — and
none of it reached the administrator, because `SecretBoxUnavailable` extended
plain `Error` and never reached the error plugin's mapping.

**Fix.** It is an `AppError` with status 503 and code
`FIVEM_SECRET_KEY_UNCONFIGURED`, and the message names the setting. Naming it to
the client is deliberate: the endpoint requires `admin.game_servers`, the
audience is the person who has to set it, and the name of a setting is not the
value of one.

**Test.** `fivem.test.ts` → *an unconfigured installation says so*. Builds a
harness with no ingest key and asserts 503, the code, and that the message names
the variable. Fails with 500 against the old class.

### T2 — Archiving an organization with staff answered 500

**Severity: low** (operability). `organization_archive_empty_check` refuses to
archive an organization that still has active members — rightly, because its
personnel history would be orphaned. That rule lived **only** in the trigger, so
its `RAISE` escaped the service as a raw Postgres error: a 500 and "Something
went wrong", for a condition that is ordinary, expected and entirely the
administrator's to fix.

**Fix.** The precondition is checked in the same transaction, under the same
lock, and refused as `ORGANIZATION_HAS_MEMBERS` (409) with the number of people
still to be transferred or terminated. The trigger stays exactly as it is — a
rule that matters this much belongs in the database, where no code path can go
round it. This is the message, not a replacement for the rule. The count is read
inside the transaction so a hire committing between check and update cannot slip
past and turn the trigger back into a 500.

**Test.** `lifecycle.test.ts` → *refuses while people still work there, and says
how many*. Asserts 409, the code, and that the message contains a count. Fails
with 500 against the old service.

### T3 — Three checks that could not fail

Not defects in the product, but worse than no coverage, because they read as
coverage:

- **The rank-ceiling check** counted `select#rank-role option:disabled` with a
  `.catch(() => 0)` around it. The picker is a Radix listbox whose options do not
  exist in the DOM until it is opened, so the count was always 0 and the `.catch`
  swallowed the failure. Now opened for real: **77 options, 11 disabled** at
  L80.
- **The audit benchmark case** filtered on `action = 'person.viewed'` for PD, and
  the fixture spreads actions round-robin across six organizations — so PD had
  none. It timed 0.3 ms over **zero rows** and looked like the fastest query in
  the system. It now reads the most common action out of the data.
- **The person-register benchmark** was not the query the application issues; the
  simplification dropped the ordering that decides the plan. Both are described
  in [performance §7](14-performance.md).

---

## 6 — What the shared database costs

The API suite runs sequentially against one Postgres database that **keeps its
accounts and memberships on purpose**: operational history must survive, so
`resetAccounts` deliberately deletes only sessions and tokens. That is the right
trade, and it has a price, paid three times this phase:

**An interrupted run leaves authority behind.** `organization_lead` accumulates
like a membership, but unlike a membership it is a grant of *authority*. A test
killed between granting and revoking left a live lead, and the next run failed an
unrelated assertion with a message about a list length. `revokeStaleTestLeads`
now runs once per harness — per *process*, not per test, because a suite is
entitled to grant a lead in `beforeAll` and rely on it.

**Assertions about global state rot.** The same test asserted "FIB has no leads
at all", which is a claim about every row in the table rather than about the
revoke under test. It now compares against the list taken before the grant:
strictly better, because it still catches a revoke that removed the wrong row.

**Fixtures outgrow a page.** The personnel walkthrough reached straight into
`tbody` for a name and started failing once PD passed 1 000 members. The roster is
paged at 50 *by design*; the walkthrough was wrong about the product. It now
searches for the row, which is what an operator does with a roster that size and
exercises the debounced filter into the bargain.

**Two suites must not run at once.** `resetAccounts` deletes every test session,
so a second suite running concurrently has its sessions pulled out from under it
and fails with a cascade of 401s that points nowhere near the cause. Run them
sequentially.

The walkthrough fixture scripts now leave a deterministic starting state where
they reasonably can — `setup-live-map.mjs` stands down panic alerts left live by
an earlier run, because the panic-bar assertions are claims about a bar with one
entry in it.

---

## 7 — Remaining risks

Stated rather than tested, because a risk written down is worth more than a test
that cannot see it.

**Concurrency is tested by construction, not by racing.** Every mutation decides
under `SELECT … FOR UPDATE` inside its transaction, and the tests assert that
shape. What is *not* done is running two conflicting mutations in parallel and
asserting one loses — the last-global-administrator count is the one place with a
targeted test. A genuine concurrency harness would be the highest-value addition
to this suite.

**Single node.** The nonce store, the ticket store, the position store, the actor
cache and the identity cache are all in-process. Each is correct on one node and
each multiplies or fragments across instances. Nothing tests multi-instance
behaviour because nothing supports it yet; this is a provisioning decision, and
it is the largest gap between the suite and production.

**Load is measured, not sustained.** The benchmarks measure query and broadcast
cost at RP scale, and `broadcast-bench` bounds messages per tick. Neither is a
soak test: nothing runs for an hour to catch a leak, and the retention sweep's
effect over weeks is reasoned about rather than observed.

**The browser walkthroughs need a human for aesthetics.** They assert structure,
content, permissions and overflow. They cannot tell whether a screen is legible
at 2 a.m. under fluorescent light, which for an operational console is a real
property. `visual-check` produces 68 screenshots for exactly that reason.

**Mail is a console transport.** Every reset and verification path is tested
against `MockMailTransport`. Delivery to a real inbox is untested because there
is no real transport yet, and the admin screen says so rather than showing a tick.

**`position_history` has no writer.** The table is indexed and the fixture fills
it, so the replay query is measured — but no application code writes to it. Its
retention policy is a policy for a hypothesis until the downsample flush lands.

**Rate limits make repeated local runs interfere.** Login is capped at 30 per IP
per 15 minutes, which is correct, and means running the walkthroughs back to back
exhausts it. There is no CI today; locally the API has to be
restarted between batches. This is the limiter working, not a defect, and it is
recorded here so the next person does not diagnose it as one.

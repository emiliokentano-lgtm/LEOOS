# 14 — Performance

Optimisation for real-world FiveM roleplay load: a fleet of a few hundred units
reporting position continuously, a person register with tens of thousands of
rows, an audit log that only ever grows, and a dozen dispatchers with three
screens each.

Every change in this document has a **measurement beside it**. Where a candidate
optimisation did not produce one, it was not made — that decision is recorded
too, in [§8](#8-measured-and-not-changed), because "we considered it and the
numbers said no" is worth more to the next person than silence.

---

## 1 — How this was measured

Guessing at what is slow in a system this size is a way to spend a week making
the wrong thing faster. So the loop was:

```
load a fixture at RP scale  →  time the application's real read paths
     →  EXPLAIN the ones that are slow  →  fix  →  time again
```

Two scripts do this and both are checked in, because a measurement nobody can
repeat is an anecdote.

**`packages/db/scripts/load-fixture.mjs`** generates the fixture:

| Table | Rows | Chosen because |
| --- | ---: | --- |
| `person` | 50 000 | a long-running server's civilian register |
| `vehicle` | 120 000 | roughly two per person |
| `user_account` / `organization_member` | 1 200 | 200 per organization |
| `unit` | 500 | a large shift across six agencies |
| `incident` | 30 000 | a year of calls |
| `audit_log` | 400 000 | a year of audited actions |
| `notification` | 200 000 | the fastest-growing table in the system |
| `position_history` | 1 000 000 | a downsampled position log |

The script **refuses to run against a database whose name does not contain
`bench`, `load` or `perf`**. That guard is there because the mistake was made:
an early run loaded 50 000 surnames into the shared test database and broke a
records test that searched for one of them. The audit rows could not be deleted
afterwards — the table is append-only by trigger — so the guard is the fix.

**`packages/db/scripts/bench-queries.mjs`** times the queries the application
actually issues, copied from the read modules rather than invented, and reports
the median of seven runs. Anything over 15 ms is flagged, anything over 50 ms is
called slow.

```
DATABASE_URL=postgres://…/leoos_bench pnpm --filter @leoos/db migrate
DATABASE_URL=postgres://…/leoos_bench pnpm --filter @leoos/db seed
DATABASE_URL=postgres://…/leoos_bench node packages/db/scripts/load-fixture.mjs
DATABASE_URL=postgres://…/leoos_bench node packages/db/scripts/bench-queries.mjs
```

---

## 2 — Database

### 2.1 The searches were sequential scans

Three of the four search surfaces had no index that their query could use.

**Global search over vehicles** matches `plate OR model OR display_name`.
`vehicle_plate_trgm_idx` and `vehicle_model_trgm_idx` both existed; nothing
covered `display_name` — and this is the part that surprises — **an `OR`
degrades to a sequential scan if any one of its branches is unindexed**. The two
indexes that were there bought nothing at all, because the planner cannot
bitmap-or a branch it has no index for. Measured: **135.3 ms → 1.6 ms**.

**The person register** matches name, phone and address. Names were covered;
phone and address were not, with the same consequence — **66.9 ms → 13.9 ms**,
the remainder of which is the alias and warrant work in
[§2.3](#23-the-alias-join-was-an-n1-that-looked-like-a-join).

The fix is three trigram indexes, in migration `0010_performance.sql`:

```sql
CREATE INDEX person_phone_trgm_idx        ON person  USING gin (phone_number  gin_trgm_ops);
CREATE INDEX person_address_trgm_idx      ON person  USING gin (address       gin_trgm_ops);
CREATE INDEX vehicle_display_name_trgm_idx ON vehicle USING gin (display_name gin_trgm_ops);
```

`gin_trgm_ops` rather than a B-tree because every one of these searches is a
substring match — an operator typing the last four digits of a phone number is
the normal case, not the exotic one, and a B-tree cannot answer it.

### 2.2 The audit log's indexes did not match its query

The audit log pages by keyset — `(occurred_at, id)` descending — and filters by
organization, action and actor. It had three single-column indexes, one per
filter column, and none of them included the sort. So a filtered page found its
rows by index and then **sorted them**, which for a common action across a year
of history is a sort over tens of thousands of rows to return twenty-five.

Three composite indexes replace them, each ending in the keyset:

```sql
CREATE INDEX audit_log_org_action_time_idx ON audit_log (organization_id, action, occurred_at DESC, id DESC);
CREATE INDEX audit_log_action_time_idx     ON audit_log (action,                  occurred_at DESC, id DESC);
CREATE INDEX audit_log_actor_time_idx      ON audit_log (actor_user_id,           occurred_at DESC, id DESC);
DROP INDEX audit_log_org_idx;
DROP INDEX audit_log_action_idx;
DROP INDEX audit_log_actor_idx;
```

The direction matters and is not decoration: a composite index can serve a sort
only if the sort's direction matches, so `occurred_at DESC, id DESC` is written
out rather than left to the default.

The three old indexes are dropped rather than kept. Each was a strict prefix of
its replacement, so it could answer nothing the new one cannot, and an index
that is never chosen still costs a write on every insert into the busiest
append-only table in the system.

Measured on the fixture: **1.26 ms → 0.60 ms**, which is a smaller number than
the reasoning above suggests and is stated as measured rather than rounded up.
The fixture spreads its actions evenly across six organizations, so
`(organization, action)` is unusually selective there and the "before" plan had
little to sort. The plan is what changed — filter-then-sort became a range scan
that stops after 50 rows — and the gap grows with the share of the log a single
action accounts for, which in a real installation is dominated by
`person.viewed` and `auth.login`.

### 2.3 The alias join was an N+1 that looked like a join

Person search matched aliases with a correlated subquery inside the `OR`, and
ordered by a correlated `count(*)` over warrants. Neither is bitmap-able, so
both ran per candidate row.

Both are now resolved separately: alias matches are collected into an id array
first (bounded at 500, because a search that matches more aliases than that is
a search that needs a better term), and the ordering uses `EXISTS` rather than
counting rows it then throws away.

An empty array needs care — `= ANY(ARRAY[]::uuid[])` is a syntax error the way
the query builder renders it, so the branch is omitted entirely when there are
no alias matches rather than passed an empty parameter.

### 2.4 The organization panel was four queries per member

`listOrganizationMembers` resolved each member's top role and lead flag with
per-row lookups. It is now one query with a `LEFT JOIN LATERAL` for the role and
a `LEFT JOIN` for the lead grant, and — separately — every list function in that
module takes a limit, defaulting to `ORGANIZATION_PANEL_LIMIT = 250`. An
unbounded list is a query whose cost is set by whoever has the largest
organization.

### 2.5 Identity resolution ran seven queries in series

See [§4](#4-the-authorization-cache). Before caching, the seven were made to run
in two waits instead of seven by grouping the independent ones into
`Promise.all`. Nothing about the queries changed; only the waiting did.

---

## 3 — Real time

### 3.1 The broadcaster re-sent the whole fleet every tick

The position broadcaster sent every visible unit's position on every tick, to
every subscriber. A fleet of 500 units and 20 dispatchers is 10 000 positions a
second — and the great majority of them describe a unit that has not moved.

`LivePositionStore` now carries a **revision**, bumped only when a sample's
value actually changes, and the broadcaster tracks the last revision it
delivered to each connection. A tick sends what changed since then.

The comparison deliberately **excludes `sampledAt`**. The FiveM bridge sends a
keep-alive on an interval so the server can tell "parked" from "crashed", which
is right for the bridge and wrong to forward: if the timestamp counted as a
change, every keep-alive would be a change and the optimisation would be a
no-op. A unit that has not moved has not moved, regardless of when it last said
so, and the client derives freshness from the last position it received.

A subscriber's baseline is reset when its **visible set** changes, so a unit
that becomes visible is sent in full rather than skipped because "nothing
changed" — the change was in who is looking, not in where it is.

Measured by `apps/api/test/broadcast-bench.test.ts`, which is a test rather than
a note so the property cannot silently regress:

```
BROADCAST first tick: 500 positions/subscriber
        steady state:  60 positions/subscriber/tick (500 units, 60 moving)
        parked fleet:   0 messages over 9 ticks
```

The parked-fleet figure is the one that matters for an RP server at 4 a.m.

### 3.2 What was already right

Throttling in the resource, batching to one request per tick, coalescing to
latest-state in the live store, one server-side clock and a 1 msg/s cap per
subscriber were all built in Phase 5 and are documented in
[03-realtime](03-realtime.md) §7. They are not repeated here. The revision
tracking above sits underneath them.

---

## 4 — The authorization cache

`resolveIdentity` runs on **every authenticated request**, before the route does
any of its own work: seven queries resolving the account, its global
capabilities, its memberships, their roles, those roles' permissions, any
overrides and any lead grants. Measured against the fixture:

```
IDENTITY full:  5.36 ms median / 11.68 ms p95
version-only:   0.45 ms median /  2.38 ms p95
```

That 5.36 ms is a floor under every endpoint in the system, including ones whose
own work is a single indexed lookup.

The engineering rule for this phase says: *do not cache data that must be
real-time unless the caching strategy is explicitly safe*. Permissions must be
real-time — a demoted sergeant must lose authority on the **next** request. So
the strategy is stated rather than assumed:

**1. The cache is keyed on a version, not a timer.** Every path that can change
a user's effective authority already calls `bumpPermissionVersion` inside its own
transaction: role assignment and removal, permission changes to a role (which
bumps *every holder*), role reordering, membership status changes, lead grants
and revocations, account disabling, capability changes. A cached entry is used
only when the version read back from the database matches the version it was
built at.

Invalidation by key change is also race-free in a way invalidation by delete is
not: a delete that lands before the commit it describes can be undone by a
concurrent read repopulating from the pre-commit state. A version bump cannot,
because the version and the change commit together. It needs no broadcast
either, which matters — a second API instance would have its own map and no way
to be told.

**2. A five-second TTL covers the one change no transaction can announce.** A
`member_permission_override` with an `expires_at` stops applying when the clock
passes it. Nothing runs at that moment and no version can be bumped. Five
seconds is the bound, it is not zero, and
`apps/api/test/identity-cache.test.ts` asserts both halves of that — the stale
window *and* the recovery — so a reader can see the size of what they are
accepting instead of taking a comment's word for it.

**3. Mutations never read the cache.** `loadActorContextLocked` calls
`resolveIdentity` directly and always will: a decision made under
`SELECT … FOR UPDATE` must see the rows it locked, not a copy taken before the
lock. A test changes authority *without* a version bump — which the cache would
honour — and proves the locked loader does not.

### The fixtures had to learn to bump

The test helpers set up state with direct SQL, deliberately: a scoping test must
be able to create the state it then proves is refused, without depending on the
endpoint that produces it. Bypassing the service also bypassed the version bump,
which would have left tests asserting against an identity resolved before their
own setup ran.

So `grantMembership`, `setPermissionOverride`, `makeGlobalAdmin`, `makeOrgLead`
and `setAccountStatus` bump too. This is not a workaround for the cache — it
makes the fixtures behave the way the production writers behave, which they
should have done anyway.

---

## 5 — API

### 5.1 Nothing is cacheable by default

Routes had been setting `cache-control: no-store` **by hand**, and the ones that
remembered were the ones whose author happened to be thinking about freshness:
the dispatch board, the map, the dashboard, notifications, the realtime ticket.
The organization panels, personnel, the person and vehicle registers, search,
roles and the entire admin surface sent no `cache-control` at all, leaving the
decision to a heuristic in whatever sits between the browser and the API.

That default is wrong twice. Operationally, a stale roster is a screen lying to
a dispatcher. For security, a cached authenticated response is one a shared
proxy can replay to the next person through it — the same class of problem as
the serialization boundary, reached through the transport instead of the DTO.

An `onSend` hook now sets `no-store` on every response that did not set
something itself, and a regression test in `security.test.ts` walks the surfaces
that were previously silent. A route serving genuinely cacheable public content
must now say so explicitly, which is a decision worth making visible.

### 5.2 A request budget for an authenticated operator

Rate limiting existed where a request is a **guess** — login, registration,
password reset, the FiveM claim code — and nowhere else. That left the surfaces
where a request is a **cost**: an authenticated session could run the global
search as fast as the network allowed, and each of those is a trigram scan over
the largest tables in the installation.

The threat here is rarely an attacker. It is a browser extension, a runaway
`setInterval` in a future screen, or a tab left open on a page whose poll got
its dependency array wrong. All three look identical from the database's side.

Two budgets, both per user:

| Budget | Limit | Applies to |
| --- | --- | --- |
| `general` | 300 / min | every authenticated `/api/v1` request |
| `search` | 60 / min | `/api/v1/search`, `/api/v1/persons`, `/api/v1/vehicles` (list) |

The second is not redundant: a page that legitimately makes 200 cheap reads a
minute should not thereby be entitled to 200 trigram scans.

**Keyed on the user, not the address.** Everyone in a roleplay community behind
one NAT — or behind one reverse proxy — presents the same IP, so an address
budget would throttle the second dispatcher to sign in rather than the one
misbehaving. That property has its own test, because a limiter keyed on the IP
passes every "does it refuse at the limit" test and is wrong in exactly the
deployment this ships into.

`general` had been defined in `LIMITS` since Phase 1 and never wired to
anything. It is wired now.

### 5.3 Pagination and query limits

Already in place and unchanged: the registers page at 25, the audit log pages by
keyset (not offset — it grows at the head while somebody reads it, and an offset
silently repeats and skips rows), and the dispatch board is bounded. Added this
phase: `ORGANIZATION_PANEL_LIMIT` on the organization list functions
([§2.4](#24-the-organization-panel-was-four-queries-per-member)) and a bound on
the alias id array ([§2.3](#23-the-alias-join-was-an-n1-that-looked-like-a-join)).

### 5.4 Retention

`purgeOldNotifications` and `purgeExpiredSessions` both existed, both were
correct, and **neither had a caller**. So `notification` — a row per recipient
per event, the fastest-growing table in the system — grew forever, and `session`
accumulated every expired row since install.

The cost is not disk. It is the badge query: an unread count is a partial-index
scan whose index keeps growing with rows the partial predicate excludes, and
every operator runs it every thirty seconds on every screen.

`apps/api/src/plugins/retention.ts` sweeps hourly, off the hot path, unref'd,
never in the first minute after boot, and disabled under `NODE_ENV=test`.

- **Read** notifications past the window are deleted. **Unread** ones are never
  deleted by age — somebody back from two weeks off still needs to see that they
  were assigned to something.
- **Expired** sessions go; revoked ones after thirty days, because a revoked
  session is evidence for that long and noise afterwards.
- The **audit log is not touched, by anything, ever**. It is the legal record and
  it is append-only by database trigger.

With more than one API instance every instance runs this and the sweeps race.
They are idempotent deletes, so racing is harmless — the loser deletes nothing —
but it is wasted work, and the right home for this is a scheduled job once one
exists. Stated here rather than discovered later.

---

## 6 — Frontend

### 6.1 A namespace import shipped the entire icon library

Navigation, statuses, unit types and notification types are **data** — each names
its icon as a string so a status added to the database can carry its own icon.
That needs a name-to-component lookup, and the obvious way to write it is:

```tsx
import * as Icons from 'lucide-react';
const Cmp = Icons[name];
```

A namespace import is opaque to tree-shaking. The bundler cannot know which
members are read, so it keeps all of them — around 1 500 components, in the
**shared** client chunk, on every page including the sign-in screen.

| | Before | After |
| --- | ---: | ---: |
| Largest client chunk | 948 KB | 228 KB |
| Total client chunks | 2.0 MB | 1.17 MB |

The replacement is an explicit 45-entry registry in `apps/web/components/icon.tsx`.
The data-driven property is kept exactly — the lookup is still by string, at
runtime — and the bundler can drop everything else.

The obvious failure mode of a hand-maintained registry is drift: a catalogue
names an icon the registry does not have, and a status silently renders blank.
`apps/web/scripts/check-icons.mjs` runs as part of `pnpm lint` and fails the
build if that happens, so the two cannot diverge quietly.

### 6.2 What was already right

The map's roster/position/freshness split — positions never entering React
state, freshness published only at a threshold crossing, measured at zero DOM
mutations in the unit list across eight seconds of a 10 Hz feed — was built in
Phase 6 and is documented in [05-map](05-map.md) §9.1. Search inputs on the
person register and global search were already debounced at 300 ms. Route-level
code splitting is Next.js's own, and the route list shows no page pulling in a
heavyweight dependency.

---

## 7 — Measurements

Against `leoos_bench` at the scale in [§1](#1-how-this-was-measured). Median of
seven runs.

### Before and after, with nothing else changed

Each row was measured twice against the same loaded database: once with the
`0010` indexes dropped, once with them present.

| Query | Before | After |
| --- | ---: | ---: |
| Global search — vehicles (`plate OR model OR display_name`) | 135.3 ms | 1.6 ms |
| Person register search (`name OR phone OR address`) | 66.9 ms | 13.9 ms |
| Audit log filtered by organization + action | 1.26 ms | 0.60 ms |
| `resolveIdentity` on every request | 5.36 ms | 0.45 ms (cache hit) |
| Positions broadcast per subscriber per tick (500 units, 60 moving) | 500 | 60 |
| Positions broadcast per tick, fleet parked | 500 | 0 |
| Largest client chunk | 948 KB | 228 KB |
| Total client chunks | 2.0 MB | 1.17 MB |

### The whole benchmark, after

```
name                                 median    p-max  rows  source
────────────────────────────────────────────────────────────────────────────────
personnel: roster page                4.7ms    5.3ms     50  personnel.read.ts listPersonnel
personnel: roster count               0.7ms    0.9ms      1  personnel.read.ts listPersonnel (total)
personnel: search by name             1.3ms    1.5ms     50  personnel.read.ts listPersonnel (search)
persons: register search             11.4ms   14.9ms     25  person.read.ts searchPersons
persons: trigram search              23.3ms   24.0ms     25  search.read.ts persons ← watch
vehicles: plate prefix                2.9ms    3.3ms     25  vehicle.read.ts searchVehicles
vehicles: global search               1.3ms    1.7ms     18  search.read.ts vehicles
vehicles: by owner                    0.2ms    0.3ms      2  person profile — owned vehicles
dispatch: open queue                  4.1ms    4.3ms    100  dispatch.read.ts listIncidents
dispatch: assignments for page        0.9ms    1.1ms     66  dispatch.read.ts listAssignments
dispatch: unit roster                 0.9ms    1.0ms     84  dispatch.read.ts listUnits
map: visible units                    2.1ms    3.8ms    484  map.read.ts listMapUnits
map: crew per unit                    0.2ms    0.3ms      0  map.read.ts crews
audit: keyset page                    0.5ms    0.7ms     50  audit.read.ts searchAuditLog
audit: filtered by action             0.5ms    0.7ms     50  audit.read.ts searchAuditLog (action)
audit: denied only                    0.4ms    0.5ms     50  audit.read.ts severity filter
audit: bounded total                  1.7ms    1.9ms      1  audit.read.ts countAuditMatches
notifications: unread badge           0.6ms    2.1ms      1  notification.service.ts unreadSummary
notifications: head page              0.5ms    0.6ms     31  notification.service.ts listNotifications
dashboard: counts                     2.6ms    3.7ms      1  dashboard.read.ts
positions: unit replay window         0.6ms    0.7ms    108  map history
```

### Two things the benchmark itself got wrong

Worth recording, because both would have led to a wrong conclusion and neither
was visible without looking at the row counts:

**A case that filtered on a value the fixture never produced.** The audit filter
was pinned to `action = 'person.viewed'` for PD, and the fixture spreads actions
round-robin across the six organizations — so PD had none of them. The case
timed 0.3 ms over **zero rows** and looked like the fastest query in the system.
It now reads the most common action for the organization out of the data.

**A case that was not the query the application issues.** The person register
case matched on the name alone and sorted by `(last_name, first_name)` — which
is exactly what `person_last_first_idx` serves, so the planner walked the name
index and filtered 45 000 rows without touching a trigram index at all. It
reported 49 ms. The application matches name OR phone OR address and sorts
wanted-first, which no single index can serve, so the planner builds a bitmap OR
across the three trigram indexes: 11 ms. A benchmark that is not the real query
can be wrong in *either* direction.

A third, in the fixture rather than the benchmark: `display_name` was left NULL
on every generated vehicle, so the branch that migration `0010` exists to index
matched nothing and the case measured the same with and without the index. The
fixture now names a realistic minority of vehicles — 1 in 200, the way a fleet
actually has "Air-1" and "Chief's car" — and the difference appears: 135 ms
against 1.6 ms.

---

## 8 — Measured, and not changed

Recorded because a rejected optimisation is information.

**The global search's similarity ranking.** `search.read.ts persons` matches with
the trigram `%` operator and sorts by `similarity()`, and it is the one case
still flagged as *watch* at 23 ms. The plan is right — a bitmap index scan on
`person_name_trgm_idx` — and the cost is entirely in computing the similarity of
the 5 000 rows it matched. That number is a fixture artefact: the generator draws
surnames from a small pool, so a tenth of the register shares one. A real
register does not, and rewriting this as a `<->` distance ordering against a
GiST index would trade a large index and a slower build for a win that only
exists in the fixture. Left alone, and noted here so the *watch* flag is not
mistaken for an unexamined problem.

**The personnel roster's level computation.** `LEVEL_SQL` computes a member's
effective hierarchy level with a correlated subquery. Rewriting it as a
`LEFT JOIN LATERAL` took it from 17 ms to 15 ms — inside the noise, at a real
cost in readability. Left alone.

**`position_history` retention.** The table is indexed for a replay window and
the fixture fills it, but **no code in the application writes to it yet**. A
retention policy for a table with no writer is a policy for a hypothesis. It
gets one when the downsample flush that feeds it is built.

**Clustering map markers.** The request raised it as a possibility. At 500 units
across the whole map the canvas renderer draws a frame well inside budget, and
the roster list does not re-render at all. Clustering would add a spatial index,
a zoom-dependent grouping rule and a new class of "why is my unit not shown"
question, to fix a problem that does not measure. If a deployment appears with
thousands of simultaneous units, this is the first thing to revisit.

**Redis.** The nonce store, the ticket store, the position store, the actor
cache and now the identity cache are all in-process. Each is documented where it
lives, each is correct on a single node, and each multiplies or fragments across
instances. This remains the single largest thing standing between LEOOS and
horizontal scaling, and it is a provisioning decision rather than a code one.

---

## 9 — What this phase did not do

- No functionality changed. Every test that passed before passes now, and the
  new ones pin the new properties rather than relaxing old ones.
- No caching was added to anything real-time except identity resolution, and
  that one is keyed on a version that every writer bumps
  ([§4](#4-the-authorization-cache)).
- The audit log was not touched, trimmed, rotated or archived.

# 09 — Dispatch Subsystem

The Leitstelle: the screen a shift is actually run from. It gets its own document
because its defining property is unlike the registers' — **everything on it is
server state that other people are looking at**, and almost every operation runs
concurrently by definition.

---

## 1. The governing distinction: self vs. others

Most of this module's authorization collapses into one question.

**Acting on yourself** — going available, crewing a unit, leaving it, raising a
panic — needs only an active membership in the organization. An officer with no
dispatch authority at all still has to be able to do all four. Requiring
`units.manage` to get into a car would make the system unusable for the people
who use it most.

**Acting on others** — creating a unit, disbanding one, assigning a call,
changing a priority, closing an incident, acknowledging someone's panic — needs
the corresponding permission.

The API groups the first set under `/api/v1/dispatch/self/*`. That grouping is
not cosmetic: it is exactly the set of endpoints that need no management
permission, and keeping them together makes it obvious when something has been
added there that should not be.

**There is deliberately no endpoint for setting another person's status.** A
status is a statement about what someone is doing. A board where a dispatcher can
declare an officer "available" on their behalf reads confidently and is wrong.
Dispatchers move units and calls; people move themselves.

---

## 2. Vocabulary: what was asked for, what is stored

The requested vocabulary and the shipped schema did not match. Both were kept, at
different layers, rather than one being duplicated into a parallel system
(engineering rules 3, 4).

### Priority

| Requested | Stored | Shown as |
| --- | --- | --- |
| Critical | `1` | `P1` · Critical |
| High | `2` | `P2` · High |
| Medium | `3` | `P3` · Medium |
| Low | `4` | `P4` · Low |
| — | `5` | `P5` · Routine |

Stored as an **integer with a CHECK constraint**, not a named enum, for two
reasons. It has to ORDER — the queue is "worst first, oldest first", which is an
index on `(priority, created_at)`; ordering named values means a lookup table or a
CASE expression in every query. And it is what people say: "we have a P1 at Legion
Square" is the radio call. Each level also carries a `name`, because a picker
offering P1–P5 tells a new dispatcher nothing — so the badge is numeric and the
picker is worded.

### Status

| Requested | Stored | Shown as |
| --- | --- | --- |
| Open | `pending` | Open |
| Dispatched | `dispatched` | Dispatched |
| Active | `on_scene` | Active |
| Contained | `contained` *(added, migration 0006)* | Contained |
| Closed | `closed` | Closed |
| — | `on_hold` | On Hold |
| — | `cancelled` | Cancelled |

Only `contained` was genuinely missing and it is the only thing the migration
adds. The rest already existed under different names and are presented as
requested: renaming stored enum values to match display labels would rewrite data
and break every index and CHECK that names them, in exchange for nothing.

`on_hold` and `cancelled` are retained. They are not part of the headline
lifecycle but they are real: a call can be parked pending information, and a call
can turn out never to have happened — which is a different outcome from being
resolved, and collapsing the two would corrupt the record.

### Operational status

Requested exactly as already seeded: Available, Busy, In Operation, At HQ, Panic,
Off Duty (plus On Scene and Transporting). `operational_status` is a **table**,
not an enum, so "the architecture should allow additional statuses later" is
already true: an organization inserts a row with `organization_id` set and it
appears in that organization's picker, on its unit board and in its filters, with
no code change (engineering rules 5–7). The status catalogue reaches the UI as
data and no component branches on a specific key — panic is flagged by
`isPanic` on the row rather than by a string comparison.

---

## 3. Transitions

`INCIDENT_TRANSITIONS` in `packages/contracts/src/dispatch.ts` is the single
source of truth, used by **both sides**: the server enforces it inside the
mutating transaction, the client reads it to grey out buttons rather than offer
one that will 409.

Three rules it encodes:

- **Closed and cancelled are terminal.** Reopening exists but is a separate
  action with its own permission, because it must carry a reason into the
  timeline — un-finishing a call is exactly the kind of thing somebody has to
  justify later.
- **Anything open can be cancelled.** A call that turns out never to have
  happened can be discovered at any point.
- **`contained` can go back to `on_scene`.** Situations get worse again, and a
  lifecycle that only moved forward would force a dispatcher to record something
  untrue.

---

## 4. Concurrency

Every mutation follows the shape the rest of the codebase uses:

```
transaction → lock the rows the decision depends on (FOR UPDATE)
            → re-read → decide → mutate → timeline → audit → commit
```

The lock matters here for a reason specific to dispatch: **two dispatchers
working the same board will act on the same call within the same second.**
Without it, "close this call" and "assign a unit to this call" interleave into a
closed incident with a live assignment — a unit committed to a call nobody is
running any more.

Closing therefore also releases every assignment and clears
`unit.current_incident_id`, in the same transaction. Leaving them attached is how
a unit ends a shift still committed to a call that finished hours ago, and how
the board's available count drifts away from reality.

---

## 5. The timeline

`incident_log` is **append-only by database trigger** and is the legal record of
the call. Every state change writes to it inside the same transaction as the
change, so a committed change always has an entry and a rolled-back one leaves
none. Tampering requires superuser access rather than an application bug.

Priority changes get their own entry rather than folding into a generic edit:
"why was this a P4 for twenty minutes" is a question that gets asked, and the
answer has to be reconstructible.

Notes are gated on `dispatch.view` alone — deliberately the lowest bar in the
module. The officer on scene is usually the one with something worth recording,
and requiring management authority to say "suspect went over the back fence"
means it gets said on radio and lost.

---

## 6. Panic

The brief is explicit that panic must not be "merely a visual frontend state".
It is four things, all server-side, all in one transaction:

1. A **row** in `panic_event` with its own lifecycle — raised, acknowledged,
   resolved.
2. A **status change** on the member and their crewed unit, so every board, the
   unit list and the map show it without any of them knowing about panic
   specifically.
3. An **audit record**.
4. A bump to the **dispatch revision**, so every polling client picks it up on its
   next tick.

Properties worth stating:

- **Raising is the weakest check in the module.** The moment someone needs this
  is the worst possible moment to discover they lack a permission.
- **Repeated presses are idempotent** while an alert is live. People press the
  button repeatedly; ten rows for one emergency makes the board harder to read
  at the moment it matters most.
- **Acknowledging is not resolving.** "A dispatcher has seen this" and "the
  officer is safe" are different facts. The alert stays on every board after
  acknowledgement, and only standing it down removes it.
- **The officer who raised it may stand it down**, without the acknowledge
  permission — the person best placed to know it is over is usually the one who
  called it. The audit records which of the two it was.
- **Resolving restores `busy`, not `available`.** Somebody who has just been
  through this is not immediately ready for the next call; a dispatcher can see
  them and decide.

Panic does **not** create an incident. The brief does not ask for it, and an
earlier confirmation dialog that promised one was corrected rather than
implemented — a confirmation that overstates what will happen is one nobody can
rely on.

---

## 7. Real-time readiness

The same seam the map uses. `DispatchDataSource` (`apps/web/lib/dispatch/`) is
push-shaped — `subscribe` with callbacks, not `getBoard()` — so the WebSocket
implementation is natural rather than a faked request/response cycle.

**The socket now carries the board**, on the `org:{id}:incidents`, `:units` and
`:panic` topics. An event says the board moved; the board then refetches through
the authorized read, which says what it moved to. Patching screen state from an
event payload would mean the payload had to carry everything the screen shows —
which is how a feed ends up broadcasting a caller's phone number to every console
that can see the topic.

The revision poll was **demoted, not deleted**. It drops to 30 seconds while the
socket is live and returns to 4 seconds when it is not. Keeping it is deliberate:
a socket can be silently wrong in ways it cannot detect — a topic denied at
subscribe time, a proxy holding a connection open with nothing flowing through it
— and a board that had stopped asking would never find out.

The poll sends the last `revision` it saw. The server compares a cheap change
marker and answers `{ changed: false }` without serialising the board, which is
the common case on a quiet shift.

The revision combines a newest-timestamp and a row count per table. A timestamp
alone misses a DELETE; a count alone misses an edit; and assignments and
acknowledgements each move a column that no other marker covers, so both are
included explicitly. It is built with the **query builder, not raw SQL** — the
first version was one hand-written statement and shipped two bugs typechecking
could not see (a column named by its Drizzle property rather than its database
name, and an array bound as a scalar).

`revision` and the per-topic `seq` now coexist by design rather than one having
replaced the other: `seq` detects a gap on the socket, `revision` decides whether
a poll needs to serialise anything. Both are cheap change markers over the same
data, and neither the board, the filters nor the detail panel know which one
prompted a refetch.

Measured end to end: a panic raised by one operator reaches a second operator's
board in **0.5–0.7 s**, with no reload (`apps/web/scripts/realtime-check.mjs`).

---

## 8. Where authority is checked

| Action | Permission | Scope check |
| --- | --- | --- |
| See the board | `dispatch.view` | own organization; 404 otherwise |
| Create a call | `dispatch.create` | owner derived from actor, never the body |
| Edit / status / priority | `dispatch.manage` | call must be in scope |
| Assign / release a unit | `dispatch.assign` | **unit** must also be in scope |
| Close / reopen | `dispatch.close` | call must be in scope |
| Add a note | `dispatch.view` | call must be in scope |
| Create / disband a unit | `units.manage` | unit must be in scope |
| Set a unit's status | `units.manage` | unit must be in scope |
| Set **your own** status | *(none)* | active membership |
| Join / leave a unit | *(none)* | active membership + unit in same organization |
| Raise a panic | `dispatch.panic` | active membership |
| Acknowledge a panic | `dispatch.panic.acknowledge` | alert must be in scope |
| Stand down a panic | `dispatch.panic.acknowledge`, **or** own alert | alert in scope |

Scope is checked **before** the permission everywhere, so a cross-organization
attempt audits as what it is rather than as a missing permission.

Coverage: `apps/api/test/dispatch.test.ts` (55 tests) and the browser walkthrough
in `apps/web/scripts/dispatch-check.mjs`, which drives two operators
simultaneously and asserts that one's panic reaches the other's board without a
reload.

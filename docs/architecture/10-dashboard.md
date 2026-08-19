# 10 — Operational Dashboard

The glance surface. Its whole job is to be **true at a glance**, which puts an
unusual weight on one question the other screens barely face: what does it do
about a number it does not have?

---

## 1. The honesty problem

A dashboard tile showing `0` is making a claim. "No incidents today" and "we
cannot count incidents today" look identical on a tile and mean opposite things,
and an operator reading `0` for average response time would conclude the service
is instantaneous rather than unmeasured.

So every derived statistic is a `Metric`, and the type makes the absent case
impossible to ignore:

```ts
type Metric =
  | { available: true;  value: number; sampleSize: number }
  | { available: false; reason: 'no-data' | 'insufficient-sample' | 'not-measured';
      sampleSize: number; detail?: string };
```

The UI renders a dash and the reason. It cannot render a number it does not have,
because there is no number to read.

**Sample size is part of the value, not a footnote.** A median over six calls and
one over six hundred are different claims. Below `MIN_METRIC_SAMPLE` (5) a
duration is not reported at all — three calls is not an average, it is three
calls.

**Exact counts are plain numbers.** `activeIncidents` is a `count(*)`, not an
estimate, so wrapping it in `Metric` would be ceremony. Only derived statistics
get the treatment.

---

## 2. What is measured, and what is not

| Shown as | Measures | Source |
| --- | --- | --- |
| **To first unit** | Call created → first unit assigned | `incident_assignment.created_at` |
| **To active** | Call created → dispatcher marked it Active | `incident_log` status transitions |
| **Response time** | Dispatch → arrival on scene | **not measured** |

The third row is the point. True response time needs a record of a unit
physically arriving. The incident timeline has an `arrival` entry type and
**nothing writes one** — no code path, and no unit reports reaching a location.
Presenting either proxy above under the name "response time" would be inventing a
number, so the payload carries it as `not-measured` with an explanation of what
it would take (the FiveM bridge, or an explicit on-scene action).

It is present in the payload rather than omitted, deliberately: an absent field
is invisible, and the gap is worth showing.

Likewise **"personnel online" is not reported**, because the word is ambiguous
and the two candidate numbers disagree badly — on a seeded database, 342 members
show an on-duty status while 2 have a live session. A duty status stays where it
was left, so counting statuses as "online" reports people who have not been seen
in days. Both figures are exact, both are shown, and each is labelled for what it
measures:

- **On duty** — current operational status is an on-duty one.
- **Signed in** — has a live, unrevoked, unexpired session.

---

## 3. Composed from dispatch, not parallel to it

Every operational figure comes from the **dispatch reads**
(`modules/dispatch/dispatch.read.ts`), not from a second set of queries
(engineering rule 4). The dashboard and the board are two views of one situation;
two query paths would be two places for the scoping rules to drift, and the first
symptom would be a dashboard count that disagrees with the board it links to.

It also shares the **dispatch revision**, so a dashboard open beside a board
cannot lag it. `apps/api/test/dashboard.test.ts` asserts the agreement directly.

Only the statistics are dashboard-only, and they take the same `DispatchScope` —
so they are scoped over exactly the rows the caller may see, for the same reason
search counts are: "MD: 12 on duty" leaks the size of another service's shift
even if you cannot list them.

---

## 4. Real-time

The brief asks the dashboard to update on six events: incident created, incident
updated, unit status changed, unit joined or left, panic, and personnel status
changed.

All six move the shared revision, so all six are covered by **one mechanism**
rather than six subscriptions, and none requires a manual refresh. The poll sends
the last revision it saw; the server answers `{ changed: false }` cheaply when
nothing has moved. `apps/api/test/dashboard.test.ts` fires each of the six and
asserts the revision moves.

The client sits behind `PollingSource` (`apps/web/lib/polling-source.ts`),
extracted at its second real use — dispatch and the dashboard. It is push-shaped
(`start(events)` with callbacks, not `getState()`) so the WebSocket that replaces
it is a second implementation rather than a redesign.

---

## 5. Layout

Everything needing a decision is above the fold on a 1920×1080 display: an
operator should not scroll to discover a P1 is unassigned.

```
alerts                          (full width, capped)
─────────────────────────────────────────────────────
active incidents │ units + today │ you
   (widest)      │   (centre)    │ (status control)
```

**Ordering is not the dispatch queue's.** The queue is worked top to bottom, so
it is strictly worst-first-oldest-first. The dashboard is *scanned*, so within a
priority an **unassigned call outranks an assigned one** — the first needs a
decision, the second is being handled.

**Alerts are capped at six**, with the remainder counted rather than dropped. A
busy shift can have a dozen open criticals; listing all of them turns the alert
panel into a second incident queue and buries the panic at the top. That is the
precise failure the brief warns about — prominent without becoming overwhelming —
so a danger alert gets a coloured left edge and a bold label, not a filled red
row. Panic is the single exception and the only thing on the screen that
animates.

**Clicking a unit status filters the unit list in place** rather than navigating.
The units are already on screen; leaving the page to see six rows would be worse.

---

## 6. States

Loading, error and empty are all real states, not afterthoughts:

- **Loading** — skeleton rows while the first snapshot arrives (the server
  renders the first one, so this is only reached on a cold client).
- **Error** — if the snapshot cannot be loaded, the screen says so and shows
  nothing else. A dashboard that renders half its figures is worse than one that
  admits it is broken, because the half that rendered looks authoritative.
- **Feed degraded** — a separate, lesser state: the figures shown are real but
  may be stale, and it says which.
- **Empty** — "No active incidents / The board is clear" is a genuine and good
  outcome, phrased as such rather than as an absence.

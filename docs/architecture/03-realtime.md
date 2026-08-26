# 03 — Real-Time Communication

> **Status: implemented.** This document described a design; it now describes what
> runs. Six things changed between the two, and each is called out below rather
> than quietly edited away — a document that hides where reality diverged from the
> plan teaches the next person nothing.
>
> | Was | Is | Why |
> | --- | --- | --- |
> | Authenticate at the HTTP upgrade from the cookie | Single-use ticket as the first message | The cookie is on the web tier's origin; the socket goes to the API's. [ADR-0013](../adr/0013-websocket-ticket-handshake.md) |
> | Snapshot then deltas, both over the socket | Snapshot over HTTP, deltas over the socket | A snapshot is a large authorized read. It already had an endpoint. |
> | Authorize per topic at subscribe time | Authorize on **every delivery** | Removes the revocation problem entirely — nothing is cached to revoke. |
> | A `permissions.changed` broadcast drives re-evaluation | No such event; the delivery check is the mechanism | One mechanism instead of two, and no window between the two. |
> | Redis pub/sub across processes | In-process hub, single node | Redis is not provisioned. Stated as a limit, not designed around. |
> | TanStack Query owns the cache | The screens own their own state | TanStack Query is not a dependency of this project. |

---

## 1. Transport decision

**WebSocket over a single connection per browser tab**, served by
`@fastify/websocket`.

| Option | Verdict |
| --- | --- |
| Server-Sent Events | Rejected. Unidirectional, so subscription management needs a parallel REST path; browsers cap concurrent SSE connections per origin on HTTP/1.1. |
| Polling | Rejected as the *primary* transport — a console polling at 1 s across 40 operators is worse than one socket in every dimension. **Kept as the fallback**, see §8. |
| Socket.IO | Rejected. Its value is fallback transports we do not need and a room model we would have to bypass to do per-topic permission checks. |
| Native WebSocket + typed protocol | **Chosen.** About 400 lines of hub, ticket and topic code, and full control of the subscribe path. |

One connection carries every topic, for the whole tab. Screens subscribe and
unsubscribe against it as they mount; navigating from dispatch to the map does not
open a second socket.

Implementation: `apps/api/src/realtime/`, `apps/web/lib/realtime/`.

---

## 2. Connection lifecycle

```
Browser                     Next.js (web)                 API
   │  POST /api/realtime/ticket │                          │
   │ ──────────────────────────▶│  forwards with the       │
   │                            │  session cookie          │
   │                            │ ────────────────────────▶│  mint: 32 random bytes
   │                            │                          │  stored SHA-256 hashed
   │ ◀──── { ticket, url } ─────│ ◀──── { ticket } ────────│  30 s TTL, single use
   │                                                       │
   │  GET /ws   (no credential in the URL)                 │
   │ ─────────────────────────────────────────────────────▶│  unauthenticated socket
   │  { t: "auth", ticket }                                │  10 s to present a ticket
   │ ─────────────────────────────────────────────────────▶│  redeem → consumed
   │ ◀──────────── { t: "ready", connectionId } ───────────│
   │                                                       │
   │  { t: "subscribe", topics: [...] }                    │
   │ ─────────────────────────────────────────────────────▶│  authorize EACH topic
   │ ◀───────── { t: "subscribed", ok, denied } ───────────│  ok carries current seq
   │                                                       │
   │ ◀───────── { t: "event", topic, seq, event } ─────────│  re-authorized per delivery
   │                                                       │
   │  { t: "ping" } ──────────────────────────────────────▶│  every 20 s
   │ ◀──────────── { t: "pong" } ──────────────────────────│
```

**Authentication is a ticket presented as the first message.** The original design
said "from the session cookie at the upgrade", which is not achievable in this
topology: the web tier re-sets `leoos_session` on **its own origin**, HttpOnly and
SameSite=Lax, so a browser opening a socket to the API origin sends no cookie at
all. The constraint that mattered — *nothing authenticating in a query string,
because query strings land in access logs* — is honoured: a first-message
credential appears in no access log, proxy log or `Referer` header. See
[ADR-0013](../adr/0013-websocket-ticket-handshake.md).

A ticket is 32 random bytes, stored hashed, valid for 30 seconds, **single use**,
and bound to the session that minted it. It grants no authority of its own — it
names a user, and every topic is then authorized from that user's live permissions.

- A socket that does not authenticate within 10 s is closed (`4401`).
- Heartbeat every 20 s; the server closes a socket silent for 60 s.
- Reconnect is exponential backoff with jitter, capped at 30 s, and mints a fresh
  ticket each time.
- **No gap-filling replay.** A client that detects a missed event refetches
  through the normal authorized read. Replay would need a durable log and would
  still be wrong after a long disconnect.

---

## 3. Topics

Topic strings are structured so the server can parse one and decide authorization
from its parts alone. A topic it cannot parse is a topic it refuses.

| Topic | Carries | Required permission |
| --- | --- | --- |
| `user:{userId}` | personal notifications | **own user only** — no permission grants access to another person's stream, including a global administrator's |
| `org:{orgId}:units` | unit create/update/disband, crewing, unit status | `dispatch.view` + membership |
| `org:{orgId}:incidents` | incident lifecycle and assignments | `dispatch.view` + membership |
| `org:{orgId}:panic` | panic raised and resolved | `dispatch.view` + membership |
| `org:{orgId}:personnel` | duty status changes | `personnel.view` + membership |
| `map:units` | batched live unit positions | `map.track_units` |

Membership means the organization the caller is **currently acting in**, or
unrestricted for a global administrator. Deliberately not "every organization they
have ever belonged to": acting as PD should not stream MD's board.

`org:{orgId}:personnel` is a higher bar than the dispatch topics on purpose.
Knowing who is on duty across a whole service is a roster, the screen that shows it
is gated on `personnel.view`, and the feed matches the screen — a second, weaker
door into the same data is how things leak.

`map:units` is filtered **per subscriber**, not per topic. The server computes each
connection's visible unit set from that user's organization and whether they hold
`map.track_all_orgs`, and a covert unit is excluded from the payload that
subscriber receives. Filtering server-side means covert positions never reach a
browser that could inspect them ([05-map §5](05-map.md)).

Four topics from the original design were **not** built: `incident:{id}`,
`map:markers`, `admin:events`, and `org:{orgId}:members`. The first is covered by
`org:{orgId}:incidents` plus a detail refetch; the second and third have no
consumer yet; the fourth was renamed `:personnel` to match the permission that
gates it.

---

## 4. Message protocol

A discriminated union defined once in `packages/contracts/src/realtime.ts` and used
by both sides — the client cannot handle an event shape the server cannot produce.

```ts
type ClientMessage =
  | { t: 'auth';        ticket: string }     // always first
  | { t: 'subscribe';   topics: string[] }
  | { t: 'unsubscribe'; topics: string[] }
  | { t: 'resync';      topics: string[] }   // "what sequence are you at?"
  | { t: 'ping' };

type ServerMessage =
  | { t: 'ready';           connectionId: string; userId: string; heartbeatMs: number }
  | { t: 'auth-failed';     reason: string }
  | { t: 'subscribed';      ok: { topic; seq }[]; denied: { topic; reason }[] }
  | { t: 'unsubscribed';    topics: string[] }
  | { t: 'event';           topic: string; seq: number; event: RealtimeEvent }
  | { t: 'resync-required'; topics: string[]; reason: string }
  | { t: 'seq';             topics: { topic; seq }[] }
  | { t: 'pong' }
  | { t: 'error';           code: string; message: string };
```

- **The socket is read-mostly.** Clients never perform dispatch actions over it;
  they call REST and observe the resulting event. One authorization path, one
  validation path, one audit path for every mutation.
- `seq` is a **per-topic** monotonic counter, incremented once per event and
  identical for every recipient — which is what makes a gap detectable at all.
- A partially-denied `subscribe` succeeds for what was allowed and reports the
  rest. Failing the whole batch would let one stale topic in a client's list
  silently break every other feed on the screen.

### Events

Fourteen, all past tense: `unit.location.updated`, `unit.status.updated`,
`unit.created`, `unit.updated`, `unit.member.joined`, `unit.member.left`,
`incident.created`, `incident.updated`, `incident.assigned`, `incident.closed`,
`panic.triggered`, `panic.resolved`, `personnel.updated`, `notification.created`.

Every event carries an id, a type, a server timestamp, an organization scope, an
actor and a payload.

**Payloads are deliberately thin.** An event says *something changed*; the
authorized read says *what it changed to*. A payload rich enough to patch a screen
would have to carry an incident's description and a caller's phone number to every
console subscribed to the topic — so it does not: `incident.updated` carries a
number, a priority and a status, and a timeline note is announced without its text.
The actor is a display name and a user id, never an email or a rank. This is
asserted by a test that searches the whole serialised frame, not just the fields
someone remembered to check (`apps/api/test/realtime.test.ts`).

A **multi-agency incident** has no owning organization, so the generic routing
would produce no topic for it. The publisher names its topics explicitly — the
owner, plus every organization with a unit on the call, read inside the same
transaction — so a joint call reaches both boards rather than neither.

---

## 4b. The payload rule, and the one feature that tested it

Event payloads carry **identifiers and the handful of fields a screen needs to
know something moved** — never a description, a note body, a caller's phone
number, an email or a rank. Asserted by tests that search the *whole serialised
frame* for planted strings, not the fields anyone remembered to check.

Chat is the first free text this system carries, and it is where that rule was
either going to hold or acquire its first exception.

**It holds.** `message.created` carries `{ conversationId, messageId,
authorMemberId }` and the client fetches the message over REST. Two options were
weighed in writing before any code — the full argument is in
[16-chat §1](16-chat.md) — and the deciding reasons were not really about the
rule at all:

- **A body could not have been rendered from a broadcast frame anyway.** A
  message can link a record that resolves *differently for different readers*, so
  a ready-to-render frame would have to be built per recipient. At that point it
  is not a broadcast, and the round trip it was meant to save has been spent on
  the server instead.
- **Membership can change between publish and delivery.** With an identifier the
  worst case is a fetch that returns 404, which is the correct answer. With a
  body, the worst case is a message delivered to somebody who has just left the
  conversation.

The leak test gained a chat case rather than a carve-out. A test with an
exception for one feature is a test somebody adds a second exception to, and the
rule's whole value is that it has none.

**Chat is also the only event type routed to explicit per-user topics rather
than an organization topic.** A conversation's audience is its membership, which
is narrower than any organization topic and changes independently of one — and
the *existence* of a conversation is itself information about who is talking to
whom.

---

## 5. Authorization

Two rules, and the second is the one that is usually got wrong.

**1. A topic is authorized from the subscriber's own live context**, never from
anything they sent. The organization in a topic string is matched against the
organization that subscriber actually acts in; a crafted topic naming someone
else's organization is a denial, not a subscription.

**2. Authorization is re-evaluated on every delivery**, not cached at subscribe
time. `RealtimeHub.publish` resolves a fresh actor context for each recipient and
re-checks the topic before writing to the socket. A subscriber who has lost the
permission stops receiving on the **next event** — not on their next reconnect —
and is sent `resync-required` so the screen refetches through the read path, which
already knows what they may now see.

This replaces the original design's `permissions.changed` broadcast and the
re-evaluation it was meant to trigger. There is no revocation machinery because
there is nothing cached to revoke, and no window between a permission changing and
a revocation message being processed.

Without this, firing someone would leave their open map tab streaming live unit
positions indefinitely. It is the most likely real-world leak in a system like
this, so it is designed for explicitly and tested directly: `apps/api/test/realtime.test.ts`
drives a deny override through a live connection and asserts the feed stops.

The cost is bounded. Dispatch events are infrequent, the actor context is cached
for one second so a burst collapses into one read, and the one high-rate path
(positions) is coalesced per subscriber — so its authorization work is
per-subscriber-per-second, not per-unit-per-second.

**Session end.** `RealtimeHub.closeSession` closes every socket a session opened,
and `TicketStore.revokeSession` invalidates its unredeemed tickets.

---

## 6. Fan-out and horizontal scale

**Today: one process, an in-memory topic index, and no bus.** Redis is not
provisioned, so the hub, the ticket store and the live position store are all
in-process. Stated as a limit rather than designed around:

- Tickets and positions do not survive a restart. A client mints another; positions
  repopulate on the next tick.
- Nothing spans processes. **This is single-node until Redis lands**, and a second
  API instance would have its own hub with its own subscribers.

The upgrade is Redis pub/sub as the bus, with each process keeping its local topic
index:

```
   POST /incidents/:id/assign
            │
            ▼
   domain service (transaction commits)
            │
            ├─▶ publish to Redis channel  leoos:org:{id}:incidents
            │
   ┌────────┴─────────┬──────────────────┐
   ▼                  ▼                  ▼
api-1              api-2              api-3
   └─ local subscribers on that topic ──┘
```

Nothing above the hub would change: services already return their events rather
than publishing them, and the publisher is a single seam.

**Publish happens after commit, never inside the transaction.** This is enforced
structurally rather than by convention: dispatch services do not have a publisher
at all. They return a `DispatchOutcome` — the value the route replies with, plus a
description of what changed — and the route publishes it, which it can only do once
the service's promise has resolved, which is once the transaction has committed.
`db.transaction(async (tx) => { …; events.unitCreated(…) })` compiles perfectly and
is wrong, so the shape makes it unwritable
(`apps/api/src/modules/dispatch/dispatch.events.ts`).

The consequence, stated plainly: a crash between commit and publish loses an event.
That is acceptable because every screen can resync — a client detecting a gap
refetches rather than trusting the stream to be complete. A durable outbox would
close the window and is deliberately deferred until there is a consumer that cannot
resync ([ADR-0006](../adr/0006-post-commit-publish.md)).

---

## 7. Position economy

The requirement is that the map feel live without the raw position rate becoming a
database or network rate. Five mechanisms, each at a different layer:

| Concern | Where it is handled |
| --- | --- |
| **Throttling** | `LocationBroadcaster` reads the store on a fixed 1 s tick and ignores the input rate entirely. The broadcast rate is a property of the server, not of the game. |
| **Batching** | `RealtimeHub.flushPositions` sends each subscriber **one message per tick** carrying every changed unit — never one message per unit. |
| **Latest-state storage** | `LivePositionStore` is keyed by unit, so a unit reporting ten times between ticks costs one entry. The hub's per-connection queue is a `Map` for the same reason. |
| **Database load** | Decoupled entirely. The store flushes to Postgres at a fraction of the tick rate, into the `unit.pos_*` columns documented as a cache. 1 Hz of position writes is the ~13M rows/day that engineering rules 21 and 22 exist to prevent. |
| **Stale detection** | The client's, from the sample timestamp travelling with each position. A position fresh when sent may be stale when read, and only the reader knows when. Beyond 15 s the marker is drawn desaturated. |

There is exactly **one clock** for this path — the broadcaster's. The hub has no
timer of its own: two timers at the same interval would flush a batch the
broadcaster was still filling, so a subscriber would receive half a tick's units
and then the other half.

Per-subscriber visibility is cached for 10 s rather than recomputed per tick — that
would be a database query per subscriber per second for a set that changes when a
unit is created, disbanded or flagged covert. A `unit.updated` event invalidates the
cache immediately, so the window is not a window in which a newly-covert unit is
still broadcast.

A subscriber with nothing pending receives **nothing at all**: a parked fleet costs
zero bytes rather than a heartbeat of empty arrays.

### Measured

`apps/web/scripts/realtime-check.mjs` drives two browser sessions and asserts on
what the second one receives. Against the mock source:

| Flow | Observed |
| --- | --- |
| `map:units` fan-out | 1 message/second/subscriber, carrying the whole visible fleet — 43 and 116 units in two runs, one message either way |
| Panic → second operator's board | **0.5–0.7 s**, no reload |
| Bytes per tick | ~60 B/unit — ~7 KB for 116 units |

The panic assertion has a ceiling well below the backstop poll interval on
purpose. If the board had only caught up because of a poll, it would time out —
so a pass is evidence about the socket specifically, not about the screen
eventually getting there.

---

## 8. Client integration

`apps/web/lib/realtime/`. One `RealtimeClient` per tab, created by
`RealtimeProvider` in the app shell so navigation reuses one connection.

The client owns the socket, the ticket handshake, reconnection, the heartbeat,
duplicate suppression (a bounded ring of recent event ids — a panic toast shown
twice teaches people to distrust the feed) and gap detection. It does **not** own
application state. It hands events to subscribers and tells them when their view is
unreliable; screens decide what to do, which is almost always to refetch.

```ts
useRealtimeRefresh(
  dispatchTopics({ userId, organizationId }),
  refresh,
  { interestingTypes: BOARD_EVENTS },
);
```

### Polling was demoted, not deleted

Every screen keeps its revision poll, and drops to `BACKSTOP_POLL_MS` (30 s) while
the socket is live. This is deliberate:

- A socket can be silently wrong in ways it cannot detect — a topic denied at
  subscribe time, a proxy holding a connection open with nothing flowing through
  it. A screen that stopped asking would never find out.
- A console on a network that blocks WebSockets keeps working, at the old rate,
  with no special case anywhere in the UI.

The status bar reports the connection's **actual** state — "Feed: live" or "Feed:
polling" — never a green light it has not earned. An operator deciding whether to
trust a board needs that indicator to be accurate more than they need it to be
reassuring.

### Recovery

| Failure | Response |
| --- | --- |
| Connection loss | `onState('reconnecting')` — the UI says so rather than silently freezing |
| Reconnect | Fresh ticket, re-subscribe every topic, backoff with jitter |
| Missed events | Sequence differs from what the client held → `onResync` → refetch |
| Duplicates | Bounded ring of recent event ids; a repeated event is dropped |
| Tab hidden | The socket is **kept** (unlike the pollers, which stop). On return, a `resync` probe asks the server for current sequence numbers, and a difference triggers a refetch |

### The map is the one exception

`RealtimeMapSource` applies position batches directly rather than refetching —
refetching a snapshot once a second is precisely the load this exists to avoid. It
composes with `HttpMapSource` rather than replacing it: snapshots still come over
HTTP, and the tick poll resumes automatically if the socket drops.

Because a position batch does not repeat a unit's status or assignment, the source
keeps a small metadata cache from the last snapshot. A unit it has never seen sets
`resyncRequired` and triggers a snapshot — it never draws a marker with a guessed
status.

# 03 — Real-Time Communication

## 1. Transport decision

**WebSocket over a single connection per browser tab**, served by
`@fastify/websocket`.

Alternatives considered:

| Option | Verdict |
| --- | --- |
| Server-Sent Events | Rejected. Unidirectional, so dispatch actions would need a parallel REST path; browsers cap concurrent SSE connections per origin on HTTP/1.1. |
| Polling | Rejected. A dispatch console polling at 1 s across 40 operators is worse than one persistent socket in every dimension. |
| Socket.IO | Rejected. Its value is fallback transports we do not need and a room model we would have to bypass anyway to do per-topic permission checks. It also imposes a wire format we would rather own. |
| Native WebSocket + typed protocol | **Chosen.** ~150 lines of hub code, full control over authorization at subscribe time. |

One connection carries all topics. Multiplexing avoids per-feature connection
sprawl and lets the server enforce a single connection budget per user.

---

## 2. Connection lifecycle

```
Browser                                API
   │  GET /ws  (session cookie)          │
   │ ───────────────────────────────────▶│  authenticate from cookie
   │                                     │  reject 401 if no live session
   │ ◀─────────── 101 Switching ─────────│
   │                                     │
   │  { t: "subscribe", topics: [...] }  │
   │ ───────────────────────────────────▶│  authorize EACH topic
   │ ◀── { t: "subscribed", ok, denied } │
   │                                     │
   │ ◀────────── snapshot ───────────────│  current state for each topic
   │ ◀────────── delta ──────────────────│  incremental updates
   │                                     │
   │  { t: "ping" } ───────────────────▶ │  every 20 s
   │ ◀────────── { t: "pong" }           │
```

- **Authentication happens at the HTTP upgrade**, from the session cookie. No
  token is passed in the query string — query strings land in access logs.
- **Authorization happens per topic at subscribe time**, and the result is not
  cached for the connection's lifetime: see §5.
- Every subscription is answered with a **snapshot first, then deltas**. A client
  that connects mid-incident must not have to guess prior state.
- Heartbeat every 20 s; the server closes a socket after 60 s of silence.
- Reconnect uses exponential backoff with jitter (1s → 30s cap) and always
  re-requests a snapshot. There is no attempt at gap-filling replay — a fresh
  snapshot is simpler and always correct.

---

## 3. Topics

Topic strings are structured and authorized individually.

| Topic | Payload | Required permission |
| --- | --- | --- |
| `user:{userId}` | personal notifications, forced logout, permission-changed | own user only |
| `org:{orgId}:members` | duty status changes, hires/terminations | `personnel.view` in org |
| `org:{orgId}:units` | patrol create/join/leave/disband, unit status | `dispatch.view` |
| `org:{orgId}:incidents` | incident lifecycle and assignments | `dispatch.view` |
| `incident:{id}` | timeline entries for one open call | `dispatch.view` + visibility |
| `org:{orgId}:panic` | panic activation and acknowledgement | `dispatch.view` |
| `map:units` | live unit position deltas | `map.track_units` |
| `map:markers` | marker add/move/remove | `map.view` |
| `admin:events` | game-server online/offline, system alerts | `admin.game_servers` |

`map:units` is filtered **per subscriber**, not per topic: the server computes each
connection's visible unit set from that user's organizations and whether they hold
`map.track_all_orgs`. An FIB unit flagged covert is excluded from the payload sent
to a PD subscriber. Filtering on the server means covert positions never reach a
browser that could inspect them.

---

## 4. Message protocol

A discriminated union defined once in `packages/contracts/src/realtime.ts` and
used by both sides — the client cannot handle an event shape the server cannot
produce.

```ts
// client → server
type ClientMessage =
  | { t: 'subscribe';   topics: string[] }
  | { t: 'unsubscribe'; topics: string[] }
  | { t: 'ping' };

// server → client
type ServerMessage =
  | { t: 'subscribed';  ok: string[]; denied: { topic: string; reason: string }[] }
  | { t: 'snapshot';    topic: string; seq: number; data: unknown }
  | { t: 'event';       topic: string; seq: number; kind: EventKind; data: unknown }
  | { t: 'resync';      topic: string }          // client must re-request snapshot
  | { t: 'pong' }
  | { t: 'error';       code: string; message: string };
```

Design notes:
- **The socket is read-mostly.** Clients do not perform dispatch actions over the
  WebSocket; they call REST endpoints and observe the resulting event. This keeps
  one authorization path, one validation path, and one audit path for every
  mutation. The socket carries only `subscribe`, `unsubscribe`, and `ping`.
- `seq` is a per-topic monotonic counter. A client detecting a gap requests a
  resync rather than trying to reconstruct.
- Payloads are minimal deltas, not whole objects, for `map:units`. Everything else
  sends the changed entity, because those events are infrequent and the bandwidth
  saving is not worth the client-side merge complexity.

---

## 5. Permission changes mid-connection

A live socket must not outlive the permissions that authorized it. When a user's
`permissionVersion` changes:

1. The API publishes to `user:{userId}` with `kind: 'permissions.changed'`.
2. The hub re-evaluates every topic that connection is subscribed to.
3. Topics that are no longer permitted are force-unsubscribed and the client is
   told which.
4. If the user's session was rotated (global capability change) or revoked
   (termination, suspension), the socket is closed with a specific code and the
   browser redirects to login.

Without step 2, firing someone would leave their open map tab streaming live unit
positions indefinitely. This is the most likely real-world leak in a system like
this, so it is designed for explicitly rather than left to reconnection.

---

## 6. Fan-out and horizontal scale

A single API process holds an in-memory topic → connection index. Across multiple
processes, Redis pub/sub is the bus:

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

- **Publish happens after commit**, never inside the transaction. Emitting before
  commit would broadcast a change that might roll back. A small transactional
  outbox is the correct upgrade if at-least-once delivery becomes a requirement;
  for operational UI state, post-commit publish with client resync on reconnect is
  proportionate. This is a deliberate trade-off, recorded in
  [ADR-0006](../adr/0006-post-commit-publish.md).
- Live unit state lives in Redis, so any process can serve a `map:units` snapshot
  without consulting another process.
- Sticky sessions are **not** required. Any process can serve any socket.

---

## 7. Throughput budget

Sizing target: 150 concurrent in-game units, 40 concurrent web operators.

| Flow | Rate | Notes |
| --- | --- | --- |
| FiveM → API ingest | 1 batched request/second per game server | one request carries all players |
| Redis writes | ~150 hash writes/second | trivial |
| `map:units` fan-out | coalesced to **1 message/second per subscriber** | the server buffers deltas and flushes on a tick; it never forwards per-player updates individually |
| Incident/unit events | order of 1/second aggregate | negligible |
| Bytes per map tick | ~40 units changed × ~60 B ≈ 2.5 KB | ~100 KB/s total across 40 operators |

The coalescing tick is the important mechanism: it decouples subscriber count from
ingest rate, so doubling operators does not double the work per position update.
Position deltas are also quantised (0.1 m, 1° heading) and unchanged units are
omitted entirely.

---

## 8. Client integration

`TanStack Query` owns the cache. The WebSocket client does not maintain a parallel
store; it patches Query's cache:

```ts
onEvent('org:123:incidents', (e) => {
  queryClient.setQueryData(['incidents', e.data.id], e.data);
  queryClient.invalidateQueries({ queryKey: ['incidents', 'list'] });
});
```

Consequences: one source of truth in the browser, REST and live data cannot
disagree, and any screen works correctly with the socket disconnected — it simply
falls back to whatever REST last returned, with a visible "live feed offline"
indicator in the status bar.

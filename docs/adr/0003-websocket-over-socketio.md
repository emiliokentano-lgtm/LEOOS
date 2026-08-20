# ADR-0003 — Native WebSocket rather than Socket.IO

**Status:** Accepted · implemented in `apps/api/src/realtime/`; handshake amended by [ADR-0013](0013-websocket-ticket-handshake.md) · 2026-08-18

## Context

Operators need live updates for units, incidents, panic alerts, and map positions.
Socket.IO is the reflexive choice for real-time in Node.

Socket.IO's principal value is transport fallback for environments where
WebSocket is unavailable, plus a rooms abstraction and automatic reconnection. Our
users are operators on desktop browsers inside a controlled deployment; WebSocket
availability is not in question. Meanwhile, our central requirement is
**per-topic authorization that re-evaluates when permissions change** — which
means owning the subscribe path rather than using a rooms API that assumes
membership is cheap and static.

## Decision

Native WebSocket via `@fastify/websocket`, with a typed message protocol defined
as a discriminated union in `packages/contracts`.

## Consequences

**Positive.** Roughly 150 lines of hub code we fully understand. Authorization
runs on every subscribe and can be re-run for every open subscription when a
user's `permissionVersion` changes. The wire format is ours, so the map's
coalescing and delta encoding are straightforward. Redis pub/sub fan-out is
explicit rather than routed through an adapter. Client and server share one type
definition, so an event shape cannot drift.

**Negative.** We implement reconnection with backoff, heartbeats, and the
snapshot/delta protocol ourselves — perhaps 200 lines on the client. No transport
fallback for exotic networks.

## Alternatives considered

*Socket.IO* — we would bypass rooms to implement per-subscriber filtering anyway,
leaving mostly the dependency weight.

*Server-Sent Events* — unidirectional, and HTTP/1.1 per-origin connection limits
make several concurrent streams awkward.

*tRPC subscriptions* — would couple the real-time layer to an RPC framework we are
not otherwise using.

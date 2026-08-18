# ADR-0006 — Post-commit publish rather than a transactional outbox

**Status:** Accepted · 2026-08-18

## Context

When a domain change commits, subscribers must learn about it. Two options:

1. **Post-commit publish** — commit the transaction, then publish to Redis. If the
   process dies between the two, the event is lost.
2. **Transactional outbox** — write the event to an `outbox` table inside the same
   transaction; a relay polls the table and publishes. Delivery is at-least-once,
   at the cost of a table, a relay process, polling latency, and idempotency
   handling on consumers.

Publishing *inside* the transaction is not an option at all: it would announce
changes that may still roll back.

## Decision

Post-commit publish, with client-side resync as the recovery mechanism.

## Consequences

**Positive.** Simple, low-latency, no extra process. Every real-time subscription
already requests a full snapshot on connect and on any detected sequence gap, so a
lost event is corrected by the next reconnect or resync rather than leaving a
client permanently wrong.

**Negative.** An event lost to a crash between commit and publish leaves connected
clients stale until they resync. For a dispatch console this means a status chip
could be briefly out of date.

**Why the trade-off is right here.** The events are *derived operational state*,
not commands, money, or messages to another system. The database remains correct
regardless, and every client can rebuild the truth from a snapshot at any moment.
An outbox buys guaranteed delivery of information that is already recoverable, and
pays for it with a relay process and idempotency logic in every consumer.

**When to revisit.** If LEOOS ever publishes events to an external system that
cannot resync — a Discord webhook, an accounting integration, an audit sink outside
our database — that consumer needs an outbox. This ADR would then be superseded
for that path only, not for the UI feed.

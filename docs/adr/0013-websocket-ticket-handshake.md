# ADR-0013 — WebSocket authentication by single-use ticket

**Status:** Accepted · 2026-08-20

## Context

[03-realtime §2](../architecture/03-realtime.md) specified that the WebSocket
authenticates **at the HTTP upgrade, from the session cookie**, and explicitly
ruled out a token in the query string on the grounds that query strings land in
access logs, proxy logs and `Referer` headers.

That is not achievable in the topology [ADR-0001](0001-split-web-and-api.md) and
[ADR-0010](0010-web-tier-holds-cookie-api-holds-truth.md) settled. The web tier holds the
session and re-sets `leoos_session` **on its own origin**, HttpOnly and
SameSite=Lax. A browser opening `new WebSocket('wss://api.…/ws')` sends no cookie
at all: it is a different origin, and the cookie was never scoped to it.

So the socket has no credential to read, and the document's stated mechanism
cannot be implemented as written. Three options.

**A. Proxy the socket through Next.js.** The cookie would then be sent, because
the socket would go to the web tier's own origin. But every position tick for
every operator would pass through the Next process, which exists to render pages
and holds no operational state. It doubles the hop count on the highest-rate path
in the system and makes the web tier a throughput bottleneck for a feed it has no
part in.

**B. Widen the cookie across both origins.** A parent-domain cookie would reach
the API. It would also reach every other subdomain, forever, on every request —
including any future static host or third-party subdomain. Widening the blast
radius of the session cookie to fix a transport problem is the wrong trade.

**C. A short-lived ticket, presented as the first WebSocket message.**

## Decision

**C.** The API mints a ticket through the authenticated server-to-server path the
web tier already uses. The browser presents it as the **first message on the
socket**, never in the URL.

```
POST /api/v1/realtime/ticket     (web tier → API, with the session cookie)
  → { ticket, expiresAt }

GET /ws                          (browser → API, no credential in the URL)
  → { t: "auth", ticket }        first message, within 10 s
  ← { t: "ready", … }
```

A ticket is:

- **32 random bytes**, base64url.
- **Stored hashed** (SHA-256). Short-lived and single-use makes this belt and
  braces, but a heap dump or a stray log of the store should yield nothing
  replayable, and the hash costs nothing at this volume.
- **Valid for 30 seconds.**
- **Single use** — redeeming deletes it, so a captured ticket is already spent by
  the time anyone could replay it.
- **Bound to the session** that minted it, so revoking the session kills every
  connection it authorised.
- **Authority-free.** It names a user. Every topic is then authorized from that
  user's live permissions, re-evaluated on every delivery
  ([03-realtime §5](../architecture/03-realtime.md)).

## Consequences

**Positive.** The constraint the original text was actually protecting — nothing
authenticating in a query string — is honoured exactly: a first-message credential
appears in no access log, no proxy log and no `Referer` header. The session cookie
stays scoped to one origin. Position traffic goes browser → API directly, with the
web tier out of the path.

**Negative.** One extra round trip before the socket opens, on every connect and
every reconnect. At 30 s TTL a ticket cannot be prefetched and held, which is the
point. The client also has to implement a small handshake state machine — a socket
that is open but not yet authenticated, with a grace period after which it is
closed.

**Storage.** The ticket store is in-process, like the live position store and for
the same reason: Redis is not provisioned. Tickets do not survive a restart (the
client mints another) and do not span instances, so this is **single-node until
Redis lands**. Moving it is a matter of implementing the same interface.

**Testing obligation.** Single use, expiry, session revocation, and refusal of a
never-issued value are release-gate tests, in `apps/api/test/realtime.test.ts`.
Single use in particular is the property the 30-second TTL is leaning on, and a
regression there would be silent.

## Alternatives considered

*Signed JWT instead of an opaque ticket* — no server-side store, so no revocation
and no single use. The two properties that make handing a browser a credential
acceptable are exactly the two a stateless token cannot have.

*Longer TTL for convenience* — 30 seconds is the whole window in which a captured
ticket is worth anything, and nothing in the flow needs longer: the client mints it
immediately before connecting.

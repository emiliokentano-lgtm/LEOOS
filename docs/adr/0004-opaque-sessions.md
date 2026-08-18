# ADR-0004 — Opaque server-side sessions rather than JWT

**Status:** Accepted · 2026-08-18

## Context

This system fires people. When a membership is terminated, an account suspended,
or a rank revoked, access must end immediately — not at the expiry of a token
already in the user's browser.

Stateless JWTs cannot be withdrawn. The standard mitigations either reintroduce
server state (a revocation list checked on every request, which is a session table
with extra steps) or shorten token lifetime to the point where the refresh traffic
matches the database load a session lookup would have caused.

We also considered existing libraries. Auth.js is built around OAuth provider
flows and fits awkwardly with a custom organization/rank model that must be
resolved per request. Lucia was discontinued as a maintained library in 2025 and
is no longer a dependency we would take on.

## Decision

Opaque random session tokens, stored hashed in a `session` table, delivered in an
`HttpOnly; Secure; SameSite=Lax` cookie. Implemented in-house.

## Consequences

**Positive.** Instant, granular revocation — one session, all of a user's
sessions, or every session for a suspended account. A visible active-session list
for the user and for administrators. A database leak yields no usable tokens,
since only `SHA-256(token)` is stored. No token-size limits on what we can
associate with a session.

**Negative.** A session lookup per request — mitigated by a 30 s Redis cache with
explicit invalidation, which makes the steady-state cost a Redis `GET`. Auth code
we own and must test, rather than delegate.

**Explicitly not a downside here.** "Stateless scaling" is JWT's main argument,
and it does not apply: this system already requires Redis and Postgres on every
request path for permissions and live state.

JWTs are still used for one thing — the short-lived internal service token the web
tier passes to the API — where the lifetime is seconds and revocation is moot.

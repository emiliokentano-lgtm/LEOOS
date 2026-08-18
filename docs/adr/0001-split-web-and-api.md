# ADR-0001 — Split the Next.js web tier from a Fastify API

**Status:** Accepted · 2026-08-18

## Context

The obvious default for a TypeScript product is a single Next.js application with
route handlers as the backend. LEOOS has two workloads that a single Next.js app
serves badly:

1. A FiveM server posting batched telemetry roughly once per second, continuously,
   forever.
2. Long-lived WebSocket connections to every operator, held open for entire shifts.

Next.js route handlers are designed around request/response. WebSocket support in
the App Router requires escaping the framework, and hosting Next.js in the way
most deployment targets expect (serverless or edge functions) makes persistent
connections either impossible or expensive.

## Decision

Two deployables in one monorepo:

- `apps/web` — Next.js 15, UI and a thin BFF layer; holds the session cookie.
- `apps/api` — Fastify 5; owns all domain logic, the only process that talks to
  Postgres, hosts the WebSocket hub and the FiveM ingest endpoints.

## Consequences

**Positive.** The two workloads scale and fail independently — a telemetry spike
cannot slow page rendering. WebSocket handling is a first-class concern in a
framework that supports it. There is exactly one authorization implementation, in
one process, because the web tier has no database access. The FiveM bridge never
touches the web tier.

**Negative.** One more service to deploy and monitor. An internal auth hop between
web and API. Shared types must live in a package rather than being implicitly
available.

**Why this is not premature abstraction.** Both workloads exist on day one and are
named in the requirements. Splitting later would mean moving every domain module
and re-establishing the authorization boundary under time pressure.

## Alternatives considered

*Single Next.js app with a custom server* — possible, but it gives up managed
Next.js hosting while still leaving domain logic tangled with rendering.

*Next.js + a separate WebSocket-only service* — the telemetry ingest and the
real-time fan-out share the live-unit state, so splitting them apart while leaving
domain logic in Next.js puts the seam in the wrong place.

# ADR-0010 — The web tier holds the cookie; the API holds the truth

**Status:** Accepted · 2026-08-19

## Context

With authentication split across two deployables ([ADR-0001](0001-split-web-and-api.md)),
something has to decide where each responsibility lives. Three arrangements were
possible:

1. **Web tier authenticates.** Next.js verifies passwords and issues sessions,
   calling the API only for domain data. This puts a second authentication
   implementation in the codebase — exactly what engineering rule 3 prohibits —
   and gives the web tier database access it should not have.
2. **Browser talks to the API directly.** No BFF hop, but the session cookie
   must then be readable cross-origin, CORS has to be widened, and server-side
   rendering loses access to the session entirely.
3. **Web tier forwards; API decides.** The browser holds an `HttpOnly` cookie
   scoped to the web origin. Server Components and server actions forward it to
   the API over an internal hop.

## Decision

Option 3.

- The browser receives `leoos_session` (`HttpOnly`) and `leoos_csrf` (readable,
  for double-submit) from the **web** origin.
- `apps/web/lib/api-client.ts` is the single place the cookie is read, and it is
  `server-only` so the internal service token cannot reach a client bundle.
- The API treats the web tier as a machine caller via `X-LEOOS-Internal`, which
  exempts it from the browser-oriented CSRF checks that do not apply to a
  server-to-server hop.
- `apps/web/lib/session.ts` keeps the signature it had when it returned fixtures.
  Screens written against it in the design phase were not touched.

## Consequences

**Positive.** One authentication implementation, in one process. The session
token is never reachable from script, so an XSS bug cannot exfiltrate it. Server
Components can render permission-filtered navigation without shipping the
permission model to the browser. Swapping the mock accessor for the real one was
an internal change to one file.

**Negative.** Every authenticated page render costs an internal round trip to
`/me`. That is a real cost and it is not yet cached — the version-keyed
permission cache described in the authorization document lands with the
authorization kernel, and until then each render re-resolves memberships. It is
acceptable at current scale and is the first thing to measure if page latency
becomes a complaint.

**Also negative.** Two cookie domains would break this if the tiers were ever
split across origins. They are deliberately deployed under one.

## What the frontend is allowed to believe

`AuthProvider` exposes the current user, memberships, roles, permissions, global
admin state and organization lead state, because the brief requires the frontend
to know all of it. Every one of those values is **cosmetic**: it decides what to
render and nothing else.

The API re-derives all of it from the database on every request and decides
fine-grained permissions inside the transaction that performs the change. If the
two ever disagree, the API is right by construction. This is stated in the
provider's own file comment as well as here, because the next person to add a
feature will read the code before they read the ADR.

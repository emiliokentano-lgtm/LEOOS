# LEOOS — Final project report

Produced at the end of the production-readiness audit, acting as Lead Engineer,
Security Engineer, QA Engineer, DevOps Engineer and UX Reviewer.

**The rule this report is written under:** nothing is described as complete
unless it is implemented *and* covered by a test that runs and passes. Where a
capability exists only as schema, only as a mock, or only as a screen, it is
said so in the same breath. Section 19 is not a courtesy list — it is the part
of this document that makes the other eighteen sections trustworthy.

**Verification behind every claim below, run at the commit this report ships with:**

| Check | Result |
| --- | --- |
| `pnpm test` | **911 passed, 0 failed, 0 skipped** — contracts 116, authz-core 116, db 41, api 638 |
| `pnpm typecheck` | clean, five packages |
| `pnpm lint` | clean |
| `pnpm build` | succeeds |
| `a11y-check.mjs` | **no problems found** |
| 13 browser walkthroughs | all green against a production build |

---

## 1. Architecture

Two processes and a database. `apps/web` (Next.js 16, React 19) renders every
screen and holds the session cookie; `apps/api` (Fastify 5) owns all domain
logic and is the only thing that touches Postgres 16. Three shared packages:
`contracts` (DTOs, permission catalogue, status catalogues, coordinate
transform), `authz-core` (pure decision functions), `db` (Drizzle schema,
migrations, seeds).

The split is deliberate and load-bearing ([ADR-0001](adr/0001-split-web-and-api.md)):
the web tier cannot make an authorization decision because it has no data to
make one from. It forwards, and the API re-derives authority on every request.

~78,600 lines of TypeScript across the workspace. Thirteen API modules
(`admin`, `auth`, `dashboard`, `dispatch`, `fivem`, `map`, `notifications`,
`organizations`, `personnel`, `persons`, `roles`, `search`, `vehicles`), each
with its own routes, service, read model and DTO layer.

**One pattern is worth naming**, because everything security-sensitive uses it:
a mutating service opens a transaction, takes `SELECT … FOR UPDATE` on both the
actor's and the target's membership, re-reads state *inside* the lock, decides,
mutates, and writes the audit row — all before commit. The route then publishes
the returned `DispatchOutcome`. An event cannot exist for a change that has no
audit row, and a decision cannot be made against state that has since moved.

Dead code and stale flags were removed in this audit: three unreferenced
components and a `mocks/` module, an `INTEGRATION_STATUS` catalogue still
asserting "No backend — UI phase", and two unused Radix packages. There are no
`TODO`/`FIXME` markers in the tree.

## 2. Implemented modules

| Module | State | Test evidence |
| --- | --- | --- |
| Authentication | Complete | `auth.test.ts` (33) |
| Authorization kernel | Complete | `packages/authz-core/test/` (116) |
| Organizations & leads | Complete | `organizations.test.ts` (23) |
| Roles & permissions | Complete | `roles.test.ts` |
| Personnel (incl. per-member overrides) | Complete | `personnel.test.ts` |
| Persons & vehicles | Complete | `records.test.ts` (38) |
| Search | Complete | `search.test.ts` (24) |
| Dashboard | Complete | `dashboard.test.ts` (25) |
| Dispatch | Complete | `dispatch.test.ts` (61) |
| Live map | Complete | `map.test.ts` (41) |
| Real-time | Complete | `realtime.test.ts` (40) |
| FiveM ingest | Complete | `fivem.test.ts` (51) |
| Notifications | Complete | `notifications.test.ts` (39) |
| Global administration | Complete | `admin.test.ts` (39) |
| End-to-end lifecycle | Complete | `lifecycle.test.ts` (42) |
| Security regressions | Complete | `security.test.ts` (40) |

Not modules, and not complete: **mail delivery** (console transport only),
**Redis** (declared, unused), **`position_history`** (schema and index only, no
writer), **map tiles**, **two-factor authentication** (a `totp_secret_enc`
column and nothing else), **criminal-charge filing** (charges are readable; no
endpoint creates one, and the `statute` catalogue has no seed).

## 3. Authentication

Registration → email verification → login → session. Argon2id hashing with the
OWASP 2024 baseline, and a production boot guard that refuses to start below it.

- **Sessions are opaque**, stored server-side ([ADR-0004](adr/0004-opaque-sessions.md)),
  with an idle timeout (12 h) and an absolute ceiling (7 d), both configurable.
- **Cookies**: `leoos_session` is `HttpOnly`/`SameSite=Lax`/`Secure` outside
  development; `leoos_csrf` is script-readable on purpose and must be echoed in
  `x-leoos-csrf` for every state-changing request.
- **Lockout**: 10 failed attempts, 15-minute lock, plus per-account and per-IP
  rate budgets on login, registration, reset request and verification resend.
- **Account disabling revokes every live session**, verified end to end — a
  terminated member's next request is a 401, not a 404.
- **Error handling does not leak**: a login failure returns one message
  regardless of whether the account exists; the specific reason is logged.
- A **session cookie that outlives its session is cleared with an explanation**
  rather than bouncing the operator between the middleware and the layout guard
  (`session-check.mjs`).

**Password reset is implemented and untested in the only way that matters: the
mail is never delivered.** The console transport prints the link to the API log.
Production refuses to boot with it unless `ALLOW_MOCK_ADAPTERS=true` is set
deliberately, and the admin system screen says "not delivering" rather than
showing a configured tick.

## 4. Authorization

Three tiers, and they do not nest:

1. **Global capabilities** (`global_admin`, `user_admin`, `audit_viewer`,
   `support`) — rows in `user_global_role`, reachable by no organization
   operation.
2. **Organization Lead** — unbounded *inside one organization*, and
   non-delegable ([ADR-0011](adr/0011-organization-lead-is-not-delegable.md)).
3. **Roles** — integer hierarchy levels ([ADR-0007](adr/0007-hierarchy-as-integer-level.md))
   carrying permission sets, plus per-member overrides (grant or deny, optional
   expiry, required reason).

Hierarchy rules **H1–H8** live in `packages/authz-core/src/decisions.ts` as pure
functions, and are evaluated inside the mutating transaction under
`SELECT … FOR UPDATE`. Route guards are coarse on purpose; the UI layer is
cosmetic and says so in its own comments.

### The five properties the brief required proof of

Each is a named test that runs and passes. `security.test.ts` gathers them as
one readable list precisely so "was this attack tested?" has a single answer.

| Property | Test |
| --- | --- |
| A user cannot promote another user above their own rank | `security.test.ts` — *1 — an officer cannot promote a lieutenant*; `personnel.test.ts` — *REFUSES promoting anyone ABOVE the actor*, *…TO THE ACTOR'S OWN LEVEL*, *…a PEER* |
| A user cannot assign a role above their own rank | `security.test.ts` — *2 — a sergeant cannot assign the chief role*; `decisions.test.ts` — *never lets an actor assign a role at or above their own level* |
| A user cannot grant permissions exceeding their own authority | `personnel.test.ts` — *REFUSES assigning a LOW role that carries a permission the actor lacks*, *…a RANK CHANGE into…*, *…a HIRE into…*; `decisions.test.ts` — *refuses granting a permission the actor does not hold* |
| An Organization Lead cannot manage another organization | `security.test.ts` — *3 — an Organization Lead cannot manage another organization*; `organizations.test.ts` — *REFUSES a PD lead editing MD, FIB, Army, ICE or Mechanic*, *refuses a lead of two organizations authority over a third* |
| A normal user cannot access global administration | `security.test.ts` — *4 — an Organization Lead cannot grant themselves global permissions*, *6 — an ordinary user cannot call admin endpoints directly*; `admin-decisions.test.ts` asserts it over the **whole capability catalogue** |

Two structural points behind those tests. Organization scope is **derived** from
the resource or the actor's membership and never read from a request body — the
`x-leoos-organization` header is a selector among memberships the caller already
holds, not an authorization input. And a lead reaching global administration is
prevented by construction rather than by a check: capabilities live in a table
no organization operation writes to, `can()` excludes global-scope keys from a
lead's implicit grant, and a database trigger refuses to attach one to an
organization role.

## 5. Organizations

Six seeded (PD, MD, FIB, Army, ICE, Mechanic), each a database row with its own
colour, category, rank structure and permission grants. Adding a seventh agency
is a seed insert. Read, edit, archive, and lead grant/revoke are implemented and
tested; archiving refuses while active members remain, with the count in the
message (a defect found and fixed during the testing phase).

A lead grant requires an active membership — `409 LEAD_REQUIRES_MEMBERSHIP` —
so authority cannot be conferred on somebody who is not in the agency.

## 6. Roles

Create, edit, reorder, archive, and permission-set editing. Roles are rows;
nothing in the authorization path compares a role name to a string, and a lint
rule bans it. Two ceilings hold at once: an actor may not create, edit, move or
delete a role at or above their own level, and may not put a permission into a
role that they do not themselves hold.

The rank picker on screen shows ranks above the actor as **offered-but-disabled**
rather than hiding them — hiding the ceiling would conceal the rule; making them
selectable would invite a request the server will refuse.

## 7. Personnel

Hire, promote, demote, assign and remove roles, terminate, callsigns, duty
status, and per-member permission overrides. Terminated members keep their
history (soft deletion, [ADR-0008](adr/0008-soft-deletion.md)) and lose rank and
the ability to act in the same transaction.

Overrides are the one place authority attaches to a person rather than a rank,
so they are the most constrained write in the product: a grant requires the
actor to hold the permission, a deny does not (it only ever reduces authority),
a global-scope key is refused for both effects, a non-active membership is
refused rather than stored, a reason is mandatory, and both the write and the
refusal are audited.

## 8. Persons

Register, profile drawer, aliases, flags, warrants, criminal and medical
sections. The permission split is real and browser-verified: a PD officer sees
criminal history and is *told* the medical record is withheld; an MD doctor sees
the reverse and is told the read is recorded.

**Criminal charges are read-only.** The schema, the read model and the UI
section exist; no endpoint files a charge, and the `statute` catalogue it
references ships empty.

## 9. Vehicles

Register, profile drawer, flags, ownership, fleet marking. A wanted owner raises
a banner on their vehicle; another organization's fleet vehicle reads as
read-only with no Edit control offered. Both browser-verified.

## 10. Search

Cross-entity (persons, vehicles, units, incidents) with per-permission redaction
and organization scoping, over trigram indexes. The scoping is verified in a
real browser from both directions: a PD officer cannot find an MD unit or an MD
incident, and a doctor cannot find the PD one. Search carries its own rate
budget (60/min) on top of the general one, because each query is a scan.

## 11. Dashboard

Live counts, alerts, and metrics as a `Metric` union: a figure that cannot be
measured carries a reason and **cannot render as a number**. Response time is
reported as *not measured*, and "personnel online" is split into the two exact
figures it used to conflate. Counts are composed from the dispatch reads and
share their revision, so the dashboard cannot disagree with the board it links
to — asserted by the walkthrough, which compares both.

## 12. Dispatch

Incidents (create, priority, status, close, reopen with a reason), units
(create, join, disband), operational statuses, assignments, panic, and an
append-only timeline. Every state change writes an `incident_log` entry **and**
an audit row in the same transaction.

Panic is a `panic_event` row with a lifecycle — raise, acknowledge, stand down —
not a client flag. The walkthrough drives the whole loop across two browser
sessions and measures propagation to a second operator without a reload.

## 13. Map

Canvas renderer with clustering, viewport culling, organization and freshness
filters, covert-unit handling, incident markers, and a panic locator.

Two things are worth stating precisely. **The filter is a view filter over a
payload the server already decided** — clearing every filter cannot reveal a
unit the caller was not entitled to, and the walkthrough proves it *while FIB
units are actively transmitting*. And **offline is a level, not a deletion**: a
unit that stops reporting stays on the board with its last known position and
last-seen time readable, with `unknown` kept distinct from `offline`.

`UNIT_OFFLINE_AFTER_MS` **is** `FIVEM_POSITION_TTL_MS` — the same constant, not
a matching number — so the client cannot believe it is tracking a unit the
server has already dropped.

**Map tiles are not in this repository.** The canvas renders over a solid base.

## 14. FiveM integration

The `leoos_bridge` resource reports positions and events from **server-side
natives**; it is standalone by default, with ESX/QBCore reachable through a
four-field adapter seam that nothing outside `server/adapters/` may touch.

Requests are HMAC-signed over a body hash, with replay, clock-skew and sequence
checks; the handshake is exempt from the sequence rule because it *establishes*
the counter (a defect the walkthrough found: a restarted game server could
otherwise never re-handshake).

**The trust model is enforced by the type system, not by a filter.** The
telemetry payload has nowhere to put an organization, rank, callsign or unit —
absent from the type, refused by a `.strict()` schema — and every organizational
fact resolves from `game_identity` → member → unit. An in-game panic runs
through the same dispatch service a browser request does. A test sends a payload
that tries to forge an organization and asserts the 400.

The ingest secret leaves the API exactly once, at creation. It is read by the
resource from a **convar**, never a file.

## 15. Real-time system

WebSocket hub with a single-use ticket handshake
([ADR-0013](adr/0013-websocket-ticket-handshake.md)), because the session cookie
could not cross the origin boundary the socket needs.

**Topic authorization is re-evaluated from the subscriber's own live context on
every delivery**, not cached at subscribe time. A demoted operator stops
receiving on the next event, with no revocation machinery — there is nothing
cached to revoke. Measured in the walkthrough, not merely asserted.

The socket is read-mostly (`auth`, `subscribe`, `unsubscribe`, `resync`, `ping`)
so every mutation keeps one validation path and one audit path. Event payloads
carry identifiers and the few fields a screen needs — never a description, a
note body, a phone number, an email or a rank — asserted by a test that searches
the whole serialised frame.

Position fan-out is throttled by one server-side clock, coalesced to the latest
state per unit, and batched to one message per second per subscriber. The
walkthrough measures **zero DOM mutations in the unit list across eight seconds
of a 10 Hz feed**.

The status bar reports the connection's actual state — "Feed: live" or
"Feed: polling" — and every screen keeps working on the revision poll when the
socket is down.

## 16. Security

- **One authentication implementation**, in the API. The web tier holds the
  cookie and forwards; it never validates a credential or evaluates a permission
  for enforcement.
- **Serialization boundary**: every response is built from a DTO in
  `packages/contracts`; returning a raw row from a handler is a lint error.
  `password_hash`, `token_hash`, `secret_hash` and `totp_secret_enc` are proven
  absent by a test that searches every endpoint's output *and* every rendered
  page.
- **Audit log** is append-only by database privilege, with triggers refusing
  `UPDATE`, `DELETE` and `TRUNCATE` — as are `incident_log` and
  `member_status_history`. Refusals are audited too: an account administrator
  repeatedly reaching for `global_admin` is the signal the log exists to surface.
  Severity is *derived* from action and outcome, never stored, and a test proves
  the SQL filter and the TypeScript label select the same rows for every action.
- **The installation cannot be locked out**: the last enabled global
  administrator cannot be disabled, the last `global_admin` grant cannot be
  revoked, and no administrator may act on their own account. The count runs
  inside the transaction under `FOR UPDATE`, so two administrators disabling
  each other cannot both succeed.
- **CSRF**: origin allow-list plus double-submit, with the internal token
  exempting only server-to-server calls. Because that token is a *complete* CSRF
  bypass for whoever knows it, production refuses to boot if it is under 32
  characters or looks like the documented placeholder.
- **Rate limiting** on login (per account and per IP), registration, reset,
  search, general API traffic (per user, not per IP) and every FiveM surface
  (per credential).
- **Input validation**: Zod on every route and every ingest payload, `.strict()`
  throughout, with bounds on every string and number; unvalidated `request.body`
  access is a lint error.
- **Logging** redacts at the logger — cookies, authorization, the internal
  token, passwords, hashes and tokens — and the request serializer logs method,
  path and remote address only, because query strings can carry tokens.
- **Secrets**: no credential is committed. `.env` and `.env.*` are gitignored
  with `!.env.example` the sole exception; the examples carry placeholders and
  generation commands.
- Seven previously-audited findings each carry a regression test
  (`security.test.ts`, and [13-security-audit](architecture/13-security-audit.md)).

**Not done:** automated secret scanning. There is no CI pipeline in this
repository, so rule 17 is held by the gitignore and by review. This was
previously claimed in `CLAUDE.md` and is now corrected there.

## 17. Testing

**911 automated tests, all passing, none skipped**: contracts 116,
authz-core 116, db 41, api 638 across 19 files. Plus **13 browser walkthroughs**
driving a real Chromium, all green.

Coverage is deliberately shaped around the authorization kernel: the
unauthorized path is tested at least as heavily as the authorized one, and the
five properties in §4 are proven at both the pure-function and the HTTP level.

The walkthroughs are release gates rather than smoke tests, and they have earned
it — they found that a restarted game server could never re-handshake, and that
an operator with a membership but no `dispatch.view` was shown "lost contact
with the server" when nothing was wrong.

**This audit fixed a gap in the gates themselves**: nine walkthroughs signed in
as fixed-name accounts, and two asserted on person, vehicle and incident
fixtures, that nothing in the repository created. They passed only on the
machine where those rows happened to exist. `setup-ui-cast.mjs` and
`setup-records.mjs` now provision both, idempotently, refusing a production
database.

Full coverage map and remaining risks: [15-testing](architecture/15-testing.md).

## 18. Deployment

Two Node processes and a Postgres 16 database. `pnpm db:migrate && pnpm db:seed`,
then `pnpm build`, then start each. Full procedure, environment reference,
reverse-proxy requirements and troubleshooting: [OPERATIONS](OPERATIONS.md).

Production configuration is guarded at boot rather than by checklist. The
process refuses to start on a sub-baseline Argon2 setting, a short or
placeholder internal token, or `POSITION_SOURCE=fivem` without an encryption
key; and refuses the console mail transport or a simulated map unless
`ALLOW_MOCK_ADAPTERS=true` is set deliberately, which is then reported in the
admin UI as the real state.

**No Dockerfile, Helm chart, Terraform or CI pipeline ships with this
repository.** The API runs under `tsx` rather than a compiled bundle — a
deliberate simplification for a single-server deployment, and a real cost at
scale.

## 19. Known limitations

1. **Single-node only.** The nonce store, WebSocket ticket store, live position
   store, actor cache, identity cache and rate limiter are all in-process, as is
   the hourly retention sweep. On two instances: a replayed FiveM request can be
   accepted by the instance that did not see the nonce, a ticket issued by one
   is unknown to the other, and each holds a different view of live positions.
   Redis is declared in `docker-compose.yml` and **not wired up**. This is the
   single largest gap between the codebase and horizontal scaling.
2. **Mail is never delivered.** Console transport only. Password reset and email
   verification work end to end *except* for arriving.
3. **`position_history` has no writer.** Table, index and replay query exist and
   are benchmarked; no application code writes to it, so the map has no history
   playback and the retention policy is a policy for a hypothesis.
4. **No map tiles.** The canvas renders over a solid base.
5. **No two-factor authentication.** A `totp_secret_enc` column exists; nothing
   reads or writes it.
6. **Criminal charges cannot be filed.** Read path complete, write path absent,
   `statute` catalogue unseeded.
7. **No CI.** No pipeline, therefore no automated secret scanning and no gate
   that the 911 tests actually ran before a merge.
8. **No compiled API build.** `tsx` at runtime.
9. **The walkthroughs need a human for aesthetics.** They assert structure,
   contrast, focus, overflow and behaviour; they cannot tell you a screen looks
   wrong.
10. **The `/design` route ships in the production bundle.** It is an unlinked
    component gallery behind the authenticated layout and exposes no data, but
    it is developer furniture in an operator's build.
11. **Running the full walkthrough battery exhausts the login rate limit**
    (30/IP/15 min). The limiter is correct; the batch has to be spaced out or
    the API restarted between runs.

## 20. Recommended next steps

In the order I would actually do them.

1. **CI.** Run `pnpm test`, `typecheck`, `lint` and `build` on every push, add
   secret scanning, and make the browser walkthroughs a nightly job with the
   setup scripts wired in. Everything else on this list is safer once a merge
   cannot silently break the kernel.
2. **Redis, for the five in-process stores.** Nonces and tickets first — those
   are the two whose in-process state is a *security* property rather than a
   performance one. Then the live position store, then the caches. Until this
   lands, "scale out" means "reintroduce a replay window".
3. **Real mail.** An SMTP transport behind the existing `MailTransport`
   interface. The seam is already there and the admin screen already reports the
   truth; this is a small change with a large honesty payoff.
4. **A writer for `position_history`**, at the 1/30 downsample the design
   already specifies, and the history playback the map's permission
   (`map.history`) already gates.
5. **A compiled API build** and a Dockerfile for both processes.
6. **Charge filing**, with a seeded statute catalogue — the one place where the
   schema promises a feature the API does not deliver.
7. **Two-factor authentication for global administrators**, using the column
   that is already there and already excluded from every DTO.
8. **Map tiles**, at which point [ADR-0012](adr/0012-defer-leaflet-until-tiles.md)
   ("defer Leaflet until tiles") comes up for review.
9. **Move `/design` behind a development-only flag**, or delete it.

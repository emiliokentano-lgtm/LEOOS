# LEOOS — Engineering Rules

**These rules are binding on every implementation phase.** They are not
aspirational. A change that violates one of them is not finished, regardless of
whether it works.

Read alongside [`docs/architecture/`](docs/architecture/). Where a rule and a
document disagree, the rule wins and the document gets corrected.

---

## The rules

### Working with existing code
1. Always inspect existing code before modifying it.
2. Never blindly overwrite working functionality.
3. Never create duplicate authentication, authorization, database, or state-management systems.
4. Prefer extending existing architecture over introducing parallel architecture.

### Data-driven domain
5. Keep organization logic data-driven.
6. Keep roles data-driven.
7. Keep permissions data-driven.
8. Never hardcode organization-specific authorization logic when the behavior can be represented through permissions and hierarchy.

### Authorization
9. **NEVER trust frontend authorization.**
10. Every security-sensitive operation must be authorized server-side.
11. Every organization-sensitive operation must validate organization scope server-side.
12. Never allow privilege escalation through manipulated API parameters.
13. Never allow a user to promote another user above their own rank.
14. Never allow a user to assign a role above their own hierarchy level.
15. Never allow a user to grant permissions they are not authorized to grant.

### Secrets and input
16. Never expose passwords, password hashes, authentication secrets, API secrets, or sensitive tokens to the frontend.
17. Never commit secrets to the repository.
18. Validate every external input.
19. FiveM data must be validated server-side.
20. Browser clients must never be considered authoritative for FiveM operational data.

### Data lifecycle
21. Keep real-time functionality efficient.
22. Do not persist extremely high-frequency location data unnecessarily.
23. Use audit logging for security-sensitive operations.
24. Historical personnel information should generally be preserved instead of hard-deleted.
25. Prefer soft deletion/deactivation for important operational records where appropriate.

### UI
26. Use loading, error and empty states throughout the UI.
27. Do not create UI components that only work for one page when a reusable abstraction is clearly appropriate.

### Code quality
28. Avoid premature abstraction.
29. Avoid unnecessary dependencies.
30. Keep the code strongly typed where possible.

### Testing
31. Write tests for important authorization logic.
32. Whenever you change security-sensitive functionality, add or update regression tests.
33. Do not weaken tests just to make them pass.

### Honesty
34. Do not fake production data and present it as real.
35. If an external integration is not yet available, use clearly marked mock/test adapters.
45. Never claim that something is implemented if it is only mocked.

### Integration boundaries
36. Keep FiveM framework-specific functionality behind adapters.
37. Do not assume ESX, QBCore, or another framework unless explicitly specified.
38. Keep frontend, backend, database, real-time and FiveM concerns separated.
39. Prefer small, understandable modules over giant files.

### Process
40. Before finishing any implementation phase, run the relevant tests and check for obvious regressions.
41. If you encounter an architectural conflict, stop and explain the conflict rather than silently creating a fragile workaround.
42. Maintain documentation for important architectural decisions.
46. When uncertain about an implementation detail, inspect the repository and existing dependencies first.
47. Before implementing a major feature, explain briefly how it fits into the existing architecture.
48. Keep backwards compatibility in mind when modifying database models or APIs.

### Posture
43. The application is an operational system. Clarity and reliability are more important than decorative UI.
44. Never sacrifice security for convenience.
49. Treat the application as production software, not as a prototype.
50. At every stage, prioritize correctness, security, maintainability and operational usability.

---

## How each rule is enforced

A rule with no enforcement mechanism is a wish. This table records where each one
is actually held.

| Rules | Mechanism | Location |
| --- | --- | --- |
| 1, 2, 4, 46 | Process: inspect before writing; no parallel systems | review |
| 3 | One auth implementation, in `apps/api` only. The web tier holds the cookie and forwards; it never validates credentials or evaluates permissions for enforcement. | [ADR-0001](docs/adr/0001-split-web-and-api.md) |
| 5, 6, 7, 8 | Organizations, roles, permissions are database rows. Lint rule bans `org.key === '…'` and `role.name === '…'` in authorization paths. | [data-model](docs/architecture/01-data-model.md) |
| 9, 10, 12 | Authorization is decided in the domain service inside the mutating transaction. Route guards are coarse; the UI layer is cosmetic. | [authz §B.7](docs/architecture/02-authorization.md) |
| 11 | Organization scope is derived from the resource or the actor's membership, never read from the request body. DB trigger blocks cross-org role assignment. | [authz §B](docs/architecture/02-authorization.md), [data-model §8](docs/architecture/01-data-model.md) |
| 13, 14, 15 | Hierarchy rules H1–H7, evaluated under `SELECT … FOR UPDATE`. | [authz §B.3](docs/architecture/02-authorization.md) |
| 16 | Explicit DTO serialization boundary — API responses are built from typed DTOs, never from ORM rows. Lint bans returning a `db.select()` result directly. | [authz §A.7](docs/architecture/02-authorization.md) |
| 17 | `.env*` gitignored; secret scanning in CI; FiveM secret read from a convar, never a file. | `.gitignore`, CI |
| 18, 19 | Zod schema on every route and every ingest payload; unvalidated `request.body` access is a lint error. | [overview §7](docs/architecture/00-overview.md) |
| 20 | All FiveM coordinates come from server-side natives. Org, rank, callsign, and permissions always resolve from the LEOOS database. | [fivem §1](docs/architecture/04-fivem-integration.md) |
| 36, 37 | The bridge's whole framework surface is four fields in `server/adapters/`; **standalone is what ships**, and nothing outside that directory may name a framework global. | [fivem §8](docs/architecture/04-fivem-integration.md), `resources/leoos_bridge/server/adapters/` |
| 21, 22 | Live state is held out of Postgres (in-process today, Redis when provisioned); Postgres receives a downsample. Position fan-out is throttled by one server-side clock, coalesced to the latest state per unit, and batched to 1 msg/s per subscriber. | [realtime §7](docs/architecture/03-realtime.md), [data-model §9](docs/architecture/01-data-model.md) |
| 23 | Single audit helper, written in the same transaction as the change; audit table is append-only by DB privilege. | [data-model §7](docs/architecture/01-data-model.md) |
| 24, 25 | Soft deletion across operational records. | [ADR-0008](docs/adr/0008-soft-deletion.md) |
| 26, 27 | `AsyncBoundary` convention; shared component inventory built before screens. | [design §4](docs/architecture/06-design-system.md) |
| 28, 29 | Every dependency justified in the overview table; abstractions introduced at the second real use. | [overview §3](docs/architecture/00-overview.md) |
| 30 | TypeScript strict + `noUncheckedIndexedAccess`; shared contracts package. | `packages/contracts` |
| 31, 32, 33 | Authz test obligations are a release gate for Phase 2 and for any later change to the kernel. | [authz §B.9](docs/architecture/02-authorization.md) |
| 34, 35, 45 | Mock adapters named `Mock*` / `Console*`, registered only in non-production config, and surfaced in the admin UI as "not connected". | see below |
| 36, 37 | FiveM framework access confined to one adapter interface; **standalone is the default**. | [fivem §8](docs/architecture/04-fivem-integration.md) |
| 38, 39 | Module boundaries per bounded context; `apps/web` has no database access. | [overview §5](docs/architecture/00-overview.md) |
| 40 | Every phase has explicit exit criteria including a green test run. | [roadmap](docs/architecture/08-roadmap.md) |
| 41 | Conflicts are raised in writing before code is written. | this file |
| 42, 47, 48 | ADRs for non-obvious decisions; forward-only reviewed migrations; `/api/v1` versioned surface. | [docs/adr](docs/adr/) |
| 43, 44, 49, 50 | Design principles; no decorative animation; security review as a Phase 8 exit gate. | [design §1](docs/architecture/06-design-system.md), [risks](docs/architecture/07-risks.md) |

### Real-time

| Rules | Mechanism | Location |
| --- | --- | --- |
| 9, 10, 11 | Topic authorization is decided from the SUBSCRIBER'S own live context and **re-evaluated on every delivery**, not cached at subscribe time. A demoted operator stops receiving on the next event, with no revocation machinery — there is nothing cached to revoke. | [realtime §5](docs/architecture/03-realtime.md), `apps/api/src/realtime/topics.ts` |
| 12 | A topic naming another organization or another user is a denial, not a subscription. A topic that will not parse is refused. | `packages/contracts/src/realtime.ts`, `apps/api/src/realtime/topics.ts` |
| 16 | Event payloads carry identifiers and the handful of fields a screen needs to know something moved — never a description, a caller's phone number, a note body, an email or a rank. Asserted by a test that searches the whole serialised frame. | [realtime §4](docs/architecture/03-realtime.md), `apps/api/test/realtime.test.ts` |
| 18 | The socket is read-mostly: it carries `auth`, `subscribe`, `unsubscribe`, `resync`, `ping` and nothing else. Every mutation goes through REST, so there is one validation path and one audit path. | [realtime §4](docs/architecture/03-realtime.md) |
| 21, 22 | Throttling, batching, latest-state coalescing and per-subscriber visibility caching, each at its own layer, with exactly one clock. | [realtime §7](docs/architecture/03-realtime.md), `apps/api/src/realtime/location-broadcaster.ts` |
| 23 | Events are emitted only for changes that were already audited: services return a `DispatchOutcome` and the route publishes it, so an event cannot exist for a change that has no audit row. | `apps/api/src/modules/dispatch/dispatch.events.ts` |
| 31, 32 | Topic authorization, ticket single-use, mid-connection demotion and payload leakage are release-gate tests. | `apps/api/test/realtime.test.ts` |
| 41 | The cookie could not cross the origin boundary the socket needs; raised and resolved in writing rather than worked around. | [ADR-0013](docs/adr/0013-websocket-ticket-handshake.md) |
| 42 | The transport document records where the implementation diverged from the design, rather than quietly editing the plan to match. | [realtime](docs/architecture/03-realtime.md) |
| 45 | The status bar reports the connection's ACTUAL state — "Feed: live" or "Feed: polling" — never a green light it has not earned. | `apps/web/components/shell/status-bar.tsx` |

### FiveM ingest

| Rules | Mechanism | Location |
| --- | --- | --- |
| 10, 19, 20 | The telemetry payload has **nowhere to put** an organization, rank, callsign or unit — absent from the type, refused by a `.strict()` schema. Every organizational fact resolves from `game_identity` → member → unit. A test sends a payload that tries to forge one. | `packages/contracts/src/fivem.ts`, `apps/api/src/modules/fivem/fivem.identity.ts` |
| 10, 12 | An in-game panic or status change runs through the SAME dispatch service a browser request does, with a scope built from the player's real permissions. The game server asking does not make it so. | `apps/api/src/modules/fivem/fivem.routes.ts` |
| 16 | The ingest secret leaves the API exactly once, at creation. No endpoint can return it again; the admin DTO does not select the columns. | `apps/api/src/modules/fivem/gameserver.routes.ts` |
| 17 | The resource reads its secret from a **convar**, never a resource file — server files reach version control and backups even though they never reach clients. | `resources/leoos_bridge/config.lua` |
| 18, 19 | Zod on every ingest payload, `.strict()` throughout, with bounds on every string and number. | `apps/api/src/modules/fivem/fivem.schema.ts` |
| 21, 22 | Throttled in the resource (distance/heading/keep-alive), batched one request per tick, coalesced in the live store, and flushed to Postgres at 1/30th the tick rate. | `resources/leoos_bridge/server/collector.lua`, `apps/api/src/plugins/fivem.ts` |
| 23 | Handshake, credential issue/revoke and identity linking are audited; a refused identity claim is audited as `denied`. | `apps/api/src/modules/fivem/` |
| 31, 32 | Signature, replay, skew, tamper, revocation and the forge-an-organization attempt are release-gate tests. | `apps/api/test/fivem.test.ts` |
| 41 | HMAC cannot verify against a one-way hash. Raised and resolved in writing rather than silently weakening the scheme. | [migration 0007](packages/db/migrations/0007_fivem.sql) |
| 45 | The map source reports the connection it has: "FiveM bridge — not reporting" when nothing is reporting, never a green light it has not earned. | `apps/api/src/modules/fivem/fivem.source.ts` |

### Live map

| Rules | Mechanism | Location |
| --- | --- | --- |
| 9, 10, 11 | The map filter is a VIEW filter over a payload the server already decided. Clearing every filter cannot reveal a unit the caller was not entitled to; the walkthrough asserts a non-cleared session receives no FIB unit **while FIB units are transmitting**, and that a session holding `map.track_all_orgs` differs only by the permission. | [map §5](docs/architecture/05-map.md), `apps/web/scripts/live-map-check.mjs` |
| 21, 22, 27 | Roster, positions and freshness are separated by HOW OFTEN THEY CHANGE. Positions never enter React state; freshness is published only at a threshold crossing. Measured, not asserted: zero DOM mutations in the unit list across eight seconds of a 10 Hz feed. | [map §9.1](docs/architecture/05-map.md), `apps/web/lib/map/unit-store.ts` |
| 24, 25 | Offline is a LEVEL, not a deletion. The unit stays in the roster with its last known position and last-update time readable, and `unknown` is kept distinct from `offline`. | [map §9.2](docs/architecture/05-map.md) |
| 30, 45 | `UNIT_OFFLINE_AFTER_MS` **is** `FIVEM_POSITION_TTL_MS` — the same constant, not a matching number — so the client cannot believe it is tracking a unit the server has already dropped. | `packages/contracts/src/map.ts` |
| 26, 43 | Panic visibility rests on three STATIC mechanisms, each sufficient alone: an unfilterable alert bar, an edge-clamped bearing arrow for an off-screen unit, and a marker drawn with halo, rings, ticks and a permanent label. No animation is load-bearing. | [map §9.4](docs/architecture/05-map.md), `apps/web/app/(app)/map/panic-locator.tsx` |
| 30 | `matchesUnitFilter` takes a computed freshness rather than reading a clock, so the predicate stays pure and the canvas and the list cannot disagree about the fleet. | `packages/contracts/src/map.ts` |
| 26, 45 | A cookie that outlives its session is cleared and the operator is told, rather than being bounced between the middleware and the layout guard until the browser gives up. Regression-checked. | [authz §A.2b](docs/architecture/02-authorization.md), `apps/web/scripts/session-check.mjs` |
| 40, 41 | The walkthrough is a release gate, and it earned its keep: it found that a restarted game server could never re-handshake, because the sequence check applied to the handshake itself. Fixed in the protocol and covered by regression tests rather than worked around in the simulator. | [fivem §The restart problem](docs/architecture/04-fivem-integration.md), `apps/api/test/fivem.test.ts` |

### Dispatch-specific

| Rules | Mechanism | Location |
| --- | --- | --- |
| 3, 4 | One duty-status truth: the shell reads the server, it does not hold a local status. Requested incident vocabulary is presented over the stored enum rather than duplicated into new columns. | [dispatch §2](docs/architecture/09-dispatch.md) |
| 5, 6, 7 | `operational_status` is a table; the status catalogue reaches the UI as data and no component branches on a key. | [dispatch §2](docs/architecture/09-dispatch.md) |
| 9, 10, 11 | Self-actions need only an active membership; everything touching another person needs a permission, checked after scope, inside the transaction. | [dispatch §1, §8](docs/architecture/09-dispatch.md) |
| 23 | Every dispatch state change writes an append-only `incident_log` entry AND an audit row in the same transaction. | [dispatch §5](docs/architecture/09-dispatch.md) |
| 45 | Panic is a `panic_event` row with a lifecycle, not a client flag; the confirmation dialog lists only what the server actually does. | [dispatch §6](docs/architecture/09-dispatch.md) |
| 34, 45 | Dashboard statistics are a `Metric` union: an unavailable figure carries a reason and cannot render as a number. Response time is reported as *not measured*, and "personnel online" is split into the two exact figures it conflated. | [dashboard §1, §2](docs/architecture/10-dashboard.md) |
| 4 | The dashboard is composed from the dispatch reads and shares its revision, so its counts cannot drift from the board it links to. | [dashboard §3](docs/architecture/10-dashboard.md) |
| 26 | Loading, error, degraded-feed and empty are all distinct states; a partial dashboard is never rendered as if whole. | [dashboard §6](docs/architecture/10-dashboard.md) |

### Security audit findings

Seven issues found by an adversarial review of the whole application. Each was
confirmed against a running system before it was fixed, and each has a
regression test that fails without the fix — see
[security audit](docs/architecture/13-security-audit.md).

| Rules | Mechanism | Location |
| --- | --- | --- |
| 9, 10, 11 | **F1** — a lead grant does NOT survive the membership it leads. `organization_lead` and `organization_member.status` are separate rows, so firing somebody left them an unbounded lead in the authorization context and reading the roster of the organization that fired them. Fixed at the root (the context no longer asserts it) AND in the kernel (the three view decisions check `membershipActive`, as the edit decision always did). | `apps/api/src/modules/auth/context.service.ts`, `packages/authz-core/src/decisions.ts` |
| 10, 44 | **F2** — a WebSocket does not outlive its session. It authenticates once and then holds only a session id, so logout, revocation, password change and account disabling did nothing to a socket already streaming live positions. Session liveness is now re-read on every subscribe and every delivery, swept on the heartbeat for map-only subscribers, and the socket is CLOSED rather than merely silenced. | `apps/api/src/modules/auth/session.service.ts`, `apps/api/src/realtime/hub.ts` |
| 11, 12 | **F3** — visible is not writable. A multi-agency incident has no owning organization, so the ownership check had nothing to compare against and any organization could close a joint call it had nothing to do with. Mutations now require cross-organization clearance or a unit actually on the call; assigning stays open, because it is how an organization JOINS one. | `apps/api/src/modules/dispatch/incident.service.ts` |
| 18, 19, 21 | **F4** — the replay-protection store is written to only AFTER the signature verifies. The key id is a header, not a secret, so consuming the nonce at position 5 let anyone who had seen one pre-burn a genuine request's nonce or exhaust memory, past a rate limiter applied after authentication. Ordering a WRITE by its cost rather than by its trust requirement is the general lesson. | `apps/api/src/modules/fivem/fivem.auth.ts`, `nonce-store.ts` |
| 23 | **F5** — TRUNCATE does not fire UPDATE/DELETE triggers, so `TRUNCATE audit_log` erased the legal record while the append-only guarantee did nothing. `BEFORE TRUNCATE` triggers on all three append-only tables. | [migration 0009](packages/db/migrations/0009_security_hardening.sql) |
| 23 | **F6** — attempts against a LOCKED account are audited. Every other refusal on the login path wrote a row; this one returned silently, so the log went quiet at exactly the moment an attack became interesting. | `apps/api/src/modules/auth/auth.service.ts` |
| 17, 44 | **F7** — `INTERNAL_API_TOKEN` is a complete CSRF bypass, and `min(16)` accepted the value printed in `.env.example`. Production refuses a short or placeholder token; the comparison is constant-time. | `apps/api/src/config.ts`, `apps/api/src/plugins/auth.ts` |
| 31, 32 | Every finding has a regression test, verified to FAIL against the pre-fix code. | `apps/api/test/security.test.ts`, `packages/authz-core/test/decisions.test.ts`, `apps/api/test/fivem.test.ts` |

### Notifications

| Rules | Mechanism | Location |
| --- | --- | --- |
| 9, 10, 11 | A notification is a PUSH of information, so its audience is exactly the set of people who could already have seen the thing by looking. Recipients are DERIVED from membership and permission inside the transaction; no contract type has anywhere to put a recipient list, and no endpoint accepts one. The permission checked is the one that gates the screen. | [notifications §1](docs/architecture/12-notifications.md), `apps/api/src/modules/notifications/recipients.ts` |
| 3, 4, 23 | Rows are written inside the caller's transaction — a rolled-back assignment leaves no "you were assigned" in anybody's bell — and delivery travels in the EXISTING `DispatchEmission` envelope, published by the route after the commit. No new publisher, no second real-time path. | `apps/api/src/modules/dispatch/dispatch.events.ts` |
| 5, 6, 7 | The type catalogue is data: icon, tone, category and audibility are table entries, so adding a type is one line rather than a branch in five components. An unknown type renders generically instead of crashing a shipped client. | `packages/contracts/src/notifications.ts` |
| 16 | Event payloads carry identifiers and a headline — never a note body, a description or a caller's phone number. The walkthrough searches every rendered notification screen for the two the fixture deliberately plants. | `apps/web/scripts/notification-check.mjs` |
| 12 | `user:<id>` is refused to everybody but its owner on every delivery. No capability grants access to another person's stream, including a global administrator's — there is no operational reason, and it would be pure surveillance. | `apps/api/src/realtime/topics.ts` |
| 21, 22 | The badge is one partial-index scan and a different request from the page; the socket is the fast path with a 30-second backstop behind it; read notifications are purged past the window and unread ones never are. | [notifications §7](docs/architecture/12-notifications.md) |
| 26, 43 | Panic reaches four surfaces, none of which is sound: a toast, the bell, the centre, and the unfilterable alert bar already on the map and the dashboard. Sound is OFF by default, gated twice, synthesised rather than shipped, and allowed to fail silently. | [notifications §5](docs/architecture/12-notifications.md), `apps/web/lib/notifications/alert-tone.ts` |
| 9, 44 | Panic cannot be muted — refused in the contracts, stripped by the API on the way in AND on the way out, and blocked by a DB CHECK so a hand-edited row cannot silence an operator either. The screen says why rather than disabling a control. | [notifications §5](docs/architecture/12-notifications.md) |
| 34, 45 | The announcement is the ONE notification a human composes, so it is the one that is narrowed: audience derived, organization from the path, `critical` refused by schema and by service, and audited. It reports the count the SERVER returned, not the roster the screen rendered. | `apps/api/src/modules/notifications/announcement.service.ts` |
| 27 | One `NotificationItem`, shared by the bell and the centre at two densities. | `apps/web/components/domain/notification-item.tsx` |
| 40, 41 | The walkthrough is a release gate, and it earned its keep: it found that an operator with a membership but no `dispatch.view` rendered a dashboard whose poll could only be refused, reporting "lost contact with the server" while nothing was wrong. A refusal is an ANSWER, not an outage. | [notifications §8](docs/architecture/12-notifications.md), `apps/web/lib/dashboard.ts` |

### Global administration

| Rules | Mechanism | Location |
| --- | --- | --- |
| 12, 13, 14, 15 | An Organization Lead reaches NO global administration, and not by a check: capabilities live in a table no organization operation writes to, `can()` excludes global-scope keys from a lead's implicit grant, and `canGrantPermissions` plus a DB trigger both refuse to attach one to an organization role. Asserted over the WHOLE catalogue. | [admin §1](docs/architecture/11-administration.md), `packages/authz-core/test/admin-decisions.test.ts` |
| 12 | Only a `global_admin` may grant a capability. A `user_admin` that could would be one request from being an administrator — and may not disable a global administrator either, which is the same escalation by subtraction. | [admin §2](docs/architecture/11-administration.md) |
| 10, 44 | The installation cannot be locked out: the last enabled global administrator cannot be disabled, the last `global_admin` grant cannot be revoked, and no administrator may act on their own account. The count runs INSIDE the transaction, under `FOR UPDATE`, so two administrators disabling each other cannot both succeed. | [admin §3](docs/architecture/11-administration.md), `apps/api/src/modules/admin/user.service.ts` |
| 16 | Three walls between `user_account` and the browser: queries name their columns, DTOs have nowhere to put a credential, and a test searches every endpoint's output AND every rendered page for hashes and secrets. | [admin §7](docs/architecture/11-administration.md), `apps/api/test/admin.test.ts` |
| 23 | Every administrative change is audited in its own transaction, and every REFUSAL is audited too — an account administrator repeatedly reaching for `global_admin` is the signal the log exists to surface. | `apps/api/src/modules/admin/user.service.ts` |
| 34, 45 | Audit severity is DERIVED from the action and outcome, never stored, so it can always be recomputed from the row and cannot drift from what happened. The rule exists twice — SQL for the filter, TypeScript for the label — and a test proves the two select the same rows for every action. | [admin §5](docs/architecture/11-administration.md) |
| 21, 22 | The audit log pages by KEYSET, not offset: it grows at the head while somebody reads it, and an offset silently repeats and skips rows. The total is bounded rather than a full scan for a figure that is stale on arrival. | `apps/api/src/modules/admin/audit.read.ts` |
| 9, 10 | No blanket prefix guard: each route asks its own question with the same functions the UI's capability block is built from, so an `audit_viewer` reaches the log without reaching the register. The page guard is a redirect, not a boundary. | [admin §8](docs/architecture/11-administration.md) |
| 35, 45 | System configuration is READ-ONLY and reports the state each component has — the mail screen says password resets are written to a log and not delivered, rather than showing a configured tick. | [admin §6](docs/architecture/11-administration.md) |
| 26 | An unavailable action states its reason in words from the API's own `restrictions` list, rather than presenting a silently disabled control. | `apps/web/app/(app)/admin/users/[userId]/` |

---

## Standing conventions

### Mock and stub adapters (rules 34, 35, 45)
Any integration not yet live ships behind an interface with a clearly named
placeholder implementation:

- Class or factory name begins with `Mock` or `Console` (`ConsoleMailTransport`,
  `MockFiveMSource`).
- Registration is refused when `NODE_ENV === 'production'` unless an explicit
  `ALLOW_MOCK_ADAPTERS` flag is set, and the process logs a warning at boot.
- Any admin screen that surfaces the integration shows its real state
  ("Mail: console transport — not delivering") rather than a success indicator.
- Seed and demo data is written to `*_demo` seeds and is never loaded into a
  production database.

Status reported to the user follows the same rule: an integration behind a mock is
described as mocked, never as working.

### Serialization boundary (rule 16)
`user_account.password_hash`, `session.token_hash`, `auth_token.token_hash`,
`game_server_credential.secret_hash`, and `user_account.totp_secret_enc` must never
leave the API process. Enforcement is structural: every response is assembled from
a DTO type in `packages/contracts`, and returning a raw row from a route handler is
a lint error rather than a code-review catch.

### Raising an architectural conflict (rule 41)
When a requirement cannot be met without weakening one of these rules, stop and
write it up: what was asked, which rule it collides with, the options, and a
recommendation. Do not ship a workaround and mention it later.

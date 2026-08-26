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
| 17 | `.env*` gitignored (`!.env.example` the sole exception); FiveM secret read from a convar, never a file. **Secret scanning is NOT wired up — there is no CI pipeline in this repository**, so this rule is held by review and by the gitignore alone. Recorded rather than claimed. | `.gitignore`, [report §16](docs/PROJECT-REPORT.md) |
| 18, 19 | Zod schema on every route and every ingest payload; unvalidated `request.body` access is a lint error. | [overview §7](docs/architecture/00-overview.md) |
| 20 | All FiveM coordinates come from server-side natives. Org, rank, callsign, and permissions always resolve from the LEOOS database. | [fivem §1](docs/architecture/04-fivem-integration.md) |
| 36, 37 | The bridge's whole framework surface is five fields in `server/adapters/` — `name`, `detect`, `getIdentity`, `getCharacterName` and the optional `isDown`; **standalone is what ships**, and nothing outside that directory may name a framework global. `isDown` was added because a roleplay framework holds a downed player at positive health, so `GetEntityHealth` answers the wrong question — which is a game-world fact and therefore legitimately an adapter's to know. Organization, rank, callsign and unit remain unreachable from any adapter. | [fivem §9](docs/architecture/04-fivem-integration.md), `resources/leoos_bridge/server/adapters/` |
| 21, 22 | Live state is held out of Postgres (in-process today, Redis when provisioned); Postgres receives a downsample. Position fan-out is throttled by one server-side clock, coalesced to the latest state per unit, and batched to 1 msg/s per subscriber. | [realtime §7](docs/architecture/03-realtime.md), [data-model §9](docs/architecture/01-data-model.md) |
| 23 | Single audit helper, written in the same transaction as the change; audit table is append-only by DB privilege. | [data-model §7](docs/architecture/01-data-model.md) |
| 24, 25 | Soft deletion across operational records. | [ADR-0008](docs/adr/0008-soft-deletion.md) |
| 26, 27 | `AsyncBoundary` convention; shared component inventory built before screens. | [design §4](docs/architecture/06-design-system.md) |
| 28, 29 | Every dependency justified in the overview table; abstractions introduced at the second real use. | [overview §3](docs/architecture/00-overview.md) |
| 30 | TypeScript strict + `noUncheckedIndexedAccess`; shared contracts package. | `packages/contracts` |
| 31, 32, 33 | Authz test obligations are a release gate for Phase 2 and for any later change to the kernel. | [authz §B.9](docs/architecture/02-authorization.md) |
| 34, 35, 45 | Mock adapters named `Mock*` / `Console*`, registered only in non-production config, and surfaced in the admin UI as "not connected". | see below |
| 36, 37 | FiveM framework access confined to one adapter interface; **standalone is the default**. | [fivem §9](docs/architecture/04-fivem-integration.md) |
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

### Performance

Every optimisation carries a before/after number taken against a checked-in
fixture at roleplay scale. Where a candidate produced no measurable win it was
NOT made, and that decision is recorded too — see
[performance §8](docs/architecture/14-performance.md).

| Rules | Mechanism | Location |
| --- | --- | --- |
| 50 | Measure, then change, then measure again. The fixture and the benchmark are both checked in, so every figure in the document can be reproduced rather than believed. The benchmark times the query the APPLICATION issues, copied from the read module named beside it — a simplified stand-in reported 49 ms for a register search that actually costs 11 ms, because the simplification dropped the ordering that decides the plan. | `packages/db/scripts/load-fixture.mjs`, `bench-queries.mjs` |
| 2, 34 | The fixture REFUSES a database not named for benchmarking. Not a comment — the comment was there and the mistake was made anyway, and the audit rows it wrote could not be deleted afterwards because the table is append-only. | `packages/db/scripts/load-fixture.mjs` |
| 21, 22 | An `OR` degrades to a sequential scan if ANY branch is unindexed, so the indexes on the other branches buy nothing: 135 ms → 1.6 ms on vehicle search, 67 ms → 14 ms on the person register. The audit log's composites end in its keyset, `occurred_at DESC, id DESC`, because a composite serves a sort only if the direction matches. | [migration 0010](packages/db/migrations/0010_performance.sql) |
| 21, 22 | A re-report of the same place is NOT a change. The position store carries a revision bumped only on real movement, and each subscriber has its own baseline — `sampledAt` is deliberately excluded from the comparison, because the bridge's keep-alive would otherwise make every tick a change and the whole thing a no-op. A parked fleet costs ZERO messages, asserted by a benchmark that is a test. | `apps/api/src/modules/map/sources/live-positions.ts`, `apps/api/test/broadcast-bench.test.ts` |
| 9, 10, 44 | Identity resolution is cached on `permission_version` — a key every mutating path already bumps inside its own transaction — NOT on a timer. A demotion takes effect on the very next request, with no wait, and a regression test fails if the version check is removed. The five-second TTL exists for the one change no transaction can announce (an override reaching `expires_at`), and the test asserts the STALE window as well as the recovery, so the size of what is being accepted is written down rather than claimed. | [performance §4](docs/architecture/14-performance.md), `apps/api/test/identity-cache.test.ts` |
| 10, 12 | A mutation never decides from the cache. `loadActorContextLocked` reads through, because a decision made under `SELECT … FOR UPDATE` must see the rows it locked — proved by a test that changes authority without a version bump. | `apps/api/src/modules/auth/context.service.ts` |
| 16, 21 | Nothing this API serves is cacheable by default. Routes had been setting `no-store` by hand and most had not; a cached authenticated response is one a shared proxy can replay to the next person through it. | `apps/api/src/plugins/auth.ts`, `apps/api/test/security.test.ts` |
| 18, 44 | Rate limiting existed where a request is a GUESS and nowhere else. Two per-USER budgets now cover where a request is a COST — and keyed on the user rather than the address, because a roleplay community behind one NAT would otherwise throttle the second dispatcher to sign in. That property has its own test. | `apps/api/src/plugins/request-limit.ts`, `apps/api/test/rate-limit.test.ts` |
| 22, 24 | Retention sweeps the two tables that grow per operator. READ notifications past the window go; UNREAD ones never go by age. The audit log is not touched by anything, ever. | `apps/api/src/plugins/retention.ts` |
| 28, 29 | A namespace import is opaque to tree-shaking, so `import * as Icons` shipped ~1 500 components in the shared chunk on every page: 948 KB → 228 KB. The registry keeps the data-driven lookup exactly, and a lint step fails the build if a catalogue names an icon it does not have. | `apps/web/components/icon.tsx`, `apps/web/scripts/check-icons.mjs` |
| 28, 34 | Rejected optimisations are recorded with their numbers: the roster's level computation (17 → 15 ms, inside the noise), marker clustering (no measurable problem at 500 units), and `position_history` retention (the table has no writer yet). | [performance §8](docs/architecture/14-performance.md) |

### Testing

874 tests across four packages plus 13 browser walkthroughs, all green, none
skipped. What could not be tested is written down rather than papered over —
see [testing §7](docs/architecture/15-testing.md).

| Rules | Mechanism | Location |
| --- | --- | --- |
| 31, 32, 40 | Every requested area has coverage AT THE LAYER IT CAN FAIL: hierarchy and permission arithmetic as properties over the whole matrix in the kernel, organization scope again at every HTTP surface, and re-authorization again on every real-time delivery. A rule proved once in `authz-core` is proved again wherever a caller could forget to consult it. | `packages/authz-core/test/`, `apps/api/test/security.test.ts` |
| 33 | A test that CANNOT FAIL is worse than no test, because it reads as coverage. Three were found and fixed: a rank-ceiling check counting options in an unopened Radix listbox behind a `.catch(() => 0)`, a benchmark filtering on a value the fixture never produced (0.3 ms over ZERO rows), and a benchmark that was not the query the application issues. | [testing §5](docs/architecture/15-testing.md) |
| 40, 41 | The end-to-end walk earned its keep on its first run: a lead grant REQUIRES a membership (so the obvious ordering is wrong, and the refusal is the front-door form of the F1 finding), termination revokes every session (401, not the 404 the test expected — the stronger answer is the one asserted), and archiving an organization with staff answered 500. | `apps/api/test/lifecycle.test.ts` |
| 26, 45 | **T1, T2** — a MISSING CONFIGURATION AND A BUSINESS RULE ARE NOT CRASHES. An unconfigured ingest key and an organization that still has staff both reached the administrator as `500 Something went wrong`, for conditions that are ordinary, expected and theirs to fix. Now 503 naming the setting, and 409 naming the number of people to transfer. The database trigger stays exactly as it is — this is the message, not a replacement for the rule. | `apps/api/src/lib/secret-box.ts`, `organization.service.ts` |
| 32 | Each of T1 and T2 has a regression test VERIFIED to fail against the pre-fix code — 500 in both cases — rather than merely written after it. | `apps/api/test/fivem.test.ts`, `lifecycle.test.ts` |
| 21, 22, 30 | Real-time lifecycle is covered where it can actually go wrong: a reconnecting client's subscribe reply carries the CURRENT sequence so it can tell it missed events, sequences never repeat or renumber when a second subscriber joins, a double subscribe does not double-deliver a panic, and ten rapid samples for one unit coalesce to the LATEST rather than the first. | `apps/api/test/realtime.test.ts` |
| 19, 20 | Ingest rate limiting is keyed per CREDENTIAL and per SURFACE, so one game server cannot spend another's budget and a heartbeat storm cannot blind dispatch by exhausting telemetry. A linked member crewing no unit is accepted and attributed to NOTHING — no unit is invented to hang a position on. | `apps/api/test/fivem.test.ts` |
| 26, 43 | The browser walkthroughs screenshot every screen at FOUR viewports down to 1024 and fail on horizontal body scroll at any of them. The two narrower ones exist because the shell already contained breakpoint logic nothing was exercising. 1024 is the floor deliberately: claiming a phone layout the product does not have would be worse than not claiming one. | `apps/web/scripts/visual-check.mjs` |
| 2, 24 | The shared test database keeps accounts and memberships ON PURPOSE, and that has a price paid three times: an interrupted run left a live lead grant that failed an unrelated assertion; an assertion about global state ("FIB has no leads at all") rotted; and a walkthrough that reached into `tbody` broke once the roster outgrew its page. Each fixed at the cause, not by loosening the assertion. | [testing §6](docs/architecture/15-testing.md), `apps/api/test/harness.ts` |
| 34, 35 | Concurrency is tested BY CONSTRUCTION (every mutation decides under `FOR UPDATE`) rather than by racing, single-node caching is untested because nothing supports multi-instance yet, and load is measured but not sustained. Stated as risks rather than implied to be covered. | [testing §7](docs/architecture/15-testing.md) |

### Visual and accessibility polish

| Rules | Mechanism | Location |
| --- | --- | --- |
| 26, 43, 50 | "WCAG AA contrast for all text" had been written in the design document since the first sketch and was NOT TRUE: 179 findings across 20 page-visits, 165 of them contrast. A principle with no instrument behind it is a wish. `a11y-check.mjs` computes the rendered ratio of every text node against the background actually painted behind it, tabs the page with a real Tab key, and is a release gate that runs to ZERO. | `apps/web/scripts/a11y-check.mjs`, [design §7](docs/architecture/06-design-system.md) |
| 27 | 139 of the 165 contrast failures were ONE TOKEN. Fixed at the ladder, not at 179 call sites: every text and status token now meets 4.5:1 on every surface, INCLUDING the hovered and selected row states. | `apps/web/app/globals.css` |
| 26, 44 | The primary button — the control every operator presses most — carried white text at 3.31:1. Semantic colours now come in two values: the plain token for text and borders, a `-solid` token dark enough to carry white as a FILL. | `apps/web/components/ui/button.tsx` |
| 26 | `text-disabled` is for INACTIVE CONTROLS only, which WCAG exempts. It had been carrying sidebar headings, an off-duty status and thirty other pieces of information; those are `tertiary` now. The deliberate exception is the permission editor, where a permission the actor cannot grant is dimmed but READABLE — the point of the row is that they can see what is out of reach. | review |
| 5, 27 | An organization's colour is DATA and cannot be made to satisfy a contrast rule at the source — it is the department's identity and is also used as a fill. `readableOn` lightens it only as far as text legibility requires, and the seven inline copies of the org tag became one component. | `apps/web/lib/readable-colour.ts`, `components/ui/org-tag.tsx` |
| 26 | ONE focus language. Buttons had no `focus-visible` rule at all and relied on a default the base reset removes; inputs and selects used a ring worth two pixels on a dark field. `outline-none` sets `outline-style: none`, so a `focus-visible:outline-2` without the style back renders nothing — which is exactly what was happening. | `components/ui/{button,input,select}.tsx` |
| 43 | THE MAP ANSWERS "WHICH ONE AM I". Nothing on a screen carrying two hundred markers did. The viewer's own unit gets a static double ring and a `YOU` tag — a shape no other marker uses — an accent rule in the list, and a *My unit* control bound to `M`. Static, like the panic emphasis: no animation is load-bearing. | `components/domain/map-canvas.tsx`, `app/(app)/map/map-view.tsx` |
| 43 | THE CALL QUEUE WORKS FROM THE KEYBOARD. ↑/↓ move through it in the order it is already sorted, so "down" always means "next most important"; the selection scrolls into view and the shortcut is printed in the panel header. A dispatcher works this board with one hand on a radio. | `app/(app)/dispatch/dispatch-view.tsx` |
| 26 | Selection moved from a background lift to a LEADING RULE. The lift had to come down for contrast, and a rule is the better signal on a dense list regardless: it survives greyscale, and a bright band across thirty rows drags the eye off the priority column. | `dispatch-view.tsx`, `map-view.tsx` |
| 33, 40 | The audit was wrong twice itself and both are recorded: it measured focus with `element.focus()`, which does not match `:focus-visible`, and it labelled findings with the URL it REQUESTED rather than the one it landed on. | [design §7](docs/architecture/06-design-system.md) |

### Per-member permission overrides (H8)

The one place authority is handed to a PERSON rather than to a rank. The data
model, the effective-permission arithmetic, the audit actions and the identity
cache's TTL were all built for it; until now nothing could actually write one.

| Rules | Mechanism | Location |
| --- | --- | --- |
| 7, 8 | An override is DATA, like everything else in the permission model: a row keyed on (member, permission) with an effect, a reason and an optional expiry. No component branches on which permission it is. | `member_permission_override` |
| 12, 13, 14, 15 | H8 composes every other rule at once — H1 rank, H6 self, H7 scope, H4 subset — because handing authority to a person bypasses the rank ladder that normally carries it. Two property tests assert over the WHOLE catalogue, at every level including unbounded, that no actor can write one for themselves and none can hand out a key outside their own set. | [authz §B](docs/architecture/02-authorization.md), `packages/authz-core/src/decisions.ts` |
| 15 | A DENY is deliberately not a grant: it only ever REDUCES authority, so the subset rule does not apply to it — a chief who does not personally use medical records must still be able to stop a subordinate using them, which is how roles already behave for removal-only edits. The rank check is not relaxed, so a deny is never an attack on somebody senior. | `canSetPermissionOverride` |
| 12 | A GLOBAL-scope key is refused for BOTH effects, and the picker never offers one. Not because a deny would escalate, but because an organization role cannot carry one — a stored row for it would read like a control and do nothing. | `canSetPermissionOverride`, `personnel.routes.ts` |
| 23 | Both the write and the clearing are audited, and so is a REFUSAL — an officer repeatedly reaching for an exception is the signal the log exists to surface. The reason is REQUIRED and carried into the audit metadata: six months later it is the only thing separating an approval from a mistake. | `apps/api/src/modules/personnel/personnel.service.ts` |
| 9, 10 | The screen is cosmetic, as always. The picker offers only what the CALLER may hand out and the form is withheld on your own record, but every rule is re-decided server-side inside the transaction with both membership rows locked. | `apps/web/app/(app)/personnel/member-drawer.tsx` |
| 26, 45 | An override on a non-active membership is REFUSED rather than stored: it would sit in the table looking like a grant, do nothing, and come alive silently if the person were reinstated. An unknown permission key is a 400 naming the field, not a foreign-key violation surfacing as a 500. | `personnel.service.ts` |
| 21, 22 | Setting or clearing one bumps `permission_version`, so it takes effect on the very next request with no wait. EXPIRY is the one case no transaction can announce — nothing runs when the clock passes `expires_at` — which is precisely what the identity cache's five-second TTL is for, and both halves are tested. | [performance §4](docs/architecture/14-performance.md) |
| 24 | An expired override is kept, not deleted: it is a record of something that was once approved, and the audit trail refers to it. Reads filter on the expiry rather than the row's existence. | `personnel.read.ts`, `context.service.ts` |

### Chat

| Rules | Mechanism | Location |
| --- | --- | --- |
| 41 | The collision with the payload rule was RAISED AND RESOLVED IN WRITING before any code: event payloads carry no free text, asserted by a test that searches the whole serialised frame, and chat is free text. Two options were weighed; the socket now carries three ids and the client fetches over REST. The leak test gained a chat case rather than a carve-out. | [chat §1](docs/architecture/16-chat.md), [realtime §4b](docs/architecture/03-realtime.md), `apps/api/test/realtime.test.ts` |
| 16 | A LINK RESOLVES PER VIEWER. Two people reading the same message correctly see different things, and the unresolved half is ABSENT from the response body — not hidden, absent. Proven by a test that searches the whole serialised response for the name, and by one that checks the entity id never travels either. | `apps/api/src/modules/chat/link-resolver.ts`, `apps/api/test/chat.test.ts` |
| 3, 4 | Link resolution reuses `SearchScope`, which already answers "which categories may this caller read, and whose rows", gated on the SAME permissions that gate each screen. A second set of rules here would be a second set to drift from the first. | `link-resolver.ts` |
| 45 | `not-permitted` and `not-found` are DIFFERENT and both are reported. Collapsing them would be tidier and would tell a reader that a record they may not see does not exist — a lie they might act on. | `MessageLinkDto` |
| 9, 10 | No permission gates ordinary conversation: talking to a colleague is not a privilege, and gating it would produce members who can read a board and cannot ask a question about it. What is gated is everything a message can REACH. | [chat §3](docs/architecture/16-chat.md) |
| 11, 12 | Membership is checked on EVERY read and every write, never cached — somebody removed from a group stops being able to read it on their next request, with no revocation machinery. A conversation the caller is not in answers NOT FOUND: its existence is information about who is talking to whom. | `chat.service.ts` |
| 12 | Chat is routed to explicit per-user topics, never an organization topic, so an event cannot reach a console that is not in the conversation. Asserted by a test with a bystander socket. | `packages/contracts/src/realtime.ts` |
| 22, 41 | A direct thread is unique by DATABASE CONSTRAINT over the ordered pair, not by a read-then-write. Two people opening a DM simultaneously would otherwise create two threads and each see half the conversation. | [migration 0013](packages/db/migrations/0013_chat.sql) |
| 21, 22 | Keyset paging on `(conversation_id, id DESC)` — ids are uuidv7 so they sort by time, and a keyset on a unique column cannot tie. Links resolve in one batched query per entity TYPE per page, not one per link. Unread is COUNTED against `last_read_at` rather than stored, because a stored counter drifts the first time a write is lost. | `chat.read.ts` |
| 23 | NOT every message. An audit row per message would double the write volume of the busiest table here and bury the administrative events the log exists to surface. Audited: creating a conversation, changing who is in it, and DELETING a message — the only action that destroys information. | `packages/db/src/schema/audit.ts` |
| 24, 25 | Deletion is soft and leaves a visible tombstone. An operational conversation is a record — "who told me to go there" is asked afterwards — and a thread whose shape changes depending on who is reading is worse than one with a visible hole. | `chat.read.ts` |
| 16 | `label_hint` is deliberately left NULL on write. Whatever the author saw is their view of the record; storing it would put a name into a row a later reader might not be entitled to. Asserted by a test. | `chat.service.ts` |

### Tasks

| Rules | Mechanism | Location |
| --- | --- | --- |
| 5, 6, 7, 8 | Priority is a TABLE, seeded in the migration because `task` has a foreign key to it — a database migrated but not seeded must still accept a task. Nothing switches on a priority key; the colour token travels with the row. | [migration 0012](packages/db/migrations/0012_tasks.sql) |
| 13, 14, 41 | Assigning is PERMISSION-gated and deliberately NOT rank-gated, which is a departure from everything else here that acts on another person. The hierarchy rules exist because rank is authority; a task is a request with a deadline. The consequence — a sergeant with `tasks.assign` can assign to a chief — is stated in the doc and pinned by a named test rather than left to be discovered. | [dashboard §4b](docs/architecture/10-dashboard.md), `apps/api/test/tasks.test.ts` |
| 9, 10, 12 | Three different questions with three different answers: assigning needs the permission, COMPLETING is the assignee's alone (not the creator's, not a chief's — somebody else ticking off your work would make the record say you did something you did not), CANCELLING is the creator's alone (the assignee cannot make work vanish by deciding it does not matter). All three verified by breaking them first. | `apps/api/src/modules/tasks/task.service.ts` |
| 11 | The assignee is read under lock from the CALLER'S organization; a member id from another agency resolves to nothing and answers NOT FOUND rather than confirming they exist elsewhere. | `createTask` |
| 24, 25 | Termination cancels open tasks assigned TO the leaver and KEEPS the ones they created — they cannot do the first set, and the second is work that still needs doing plus a record of who asked. History preserved, live state corrected. | `personnel.service.ts`, `cancelTasksForDepartedMember` |
| 30, 45 | Overdue is DERIVED from `due_at` against a clock, never stored — a stored flag is wrong between the moment a deadline passes and whatever job noticed. `taskState` and `compareTasks` take the clock as an argument, so the API's ordering and the browser's cannot disagree. | `packages/contracts/src/tasks.ts` |
| 26 | Loading, FAILED, empty and loaded are four states and they look different. A list rendered empty because a request timed out is a lie in the safe-looking direction — the operator concludes there is nothing to do — so a failed load says so in words. | `apps/web/app/(app)/dashboard/task-panel.tsx` |
| 21, 22 | Tasks are polled on their own minute-long clock rather than folded into the dashboard snapshot, which moves every few seconds: a task list changes when somebody assigns or ticks one. The panel's own tick is per MINUTE, because a deadline is measured in hours — the field-request strip ticks per second because it counts down from three minutes. | `dashboard-view.tsx` |
| 23 | Four audit keys. Assignment and cancellation because they are one member acting on another's workload; completion because "it was done" is the claim the feature exists to record; re-opening because undoing that claim is what somebody would later dispute. | `packages/db/src/schema/audit.ts` |
| 43 | Overdue and due-soon are called out in WORDS as well as colour and position, and the ordering puts what is already late at the top without a sort or a filter. | `task-panel.tsx` |

### Field requests

| Rules | Mechanism | Location |
| --- | --- | --- |
| 3, 4, 28 | Backup and location sharing are ONE table and ONE service with two outcomes on accept, not two features. Writing them separately would have duplicated the lifecycle, the audience derivation, the expiry rule and the authorization. Accepting a location share places an ordinary `map_marker` rather than a second map layer meaning the same thing. | [dispatch §6b](docs/architecture/09-dispatch.md), `apps/api/src/modules/dispatch/field-request.service.ts` |
| 4, 41 | A field request is NOT an incident, and accepting does not create one. An incident is a call somebody has to close; manufacturing one so an assignment has a foreign key to point at would put untitled entries on the board forever. Where there is no call, the acceptance still stands and attaches to nothing — asserted by a test that counts incidents before and after. | [dispatch §6b](docs/architecture/09-dispatch.md) |
| 9, 10, 11 | The audience is DERIVED from membership and duty status inside the transaction. No contract type has a recipient field and `.strict()` makes "nowhere to put one" true rather than "ignored" — a body carrying `recipients` or `organizationId` is a 400. Even the accept notification, whose audience is exactly one person, reads that person from the row. | `field-request.service.ts`, `apps/api/test/field-requests.test.ts` |
| 12 | Accepting is authorized against the RESPONDER'S live membership, never against anything the request or the caller supplied. A request in another organization is NOT FOUND rather than forbidden — a 403 would confirm it exists, which is itself information about another agency. | `respondToFieldRequest` |
| 23 | Four audit keys rather than one, because the questions asked afterwards differ. A DECLINE is a row: "eight people dismissed this" is a different fact from "nobody saw it", and it is the first thing asked when help did not arrive. | `packages/db/src/schema/audit.ts`, `field_request_response` |
| 21, 22 | Expiry is a COLUMN evaluated on read, not a job. Nothing runs when nobody is looking, and a client holding a stale prompt cannot accept past the deadline because the deadline is enforced where the decision is made. The live count is folded into the dispatch revision, so an expiry moves it without any row being written. | `field-request.read.ts`, `dispatch.read.ts` |
| 22 | One live request per member per kind, enforced by a partial UNIQUE index. A held key or a retrying network must not put four identical prompts on every screen, and only the database can decide that under concurrency. | [migration 0011](packages/db/migrations/0011_field_requests.sql) |
| 16 | The realtime payload carries an id, a kind and a status — never the note, the asker's name or the position. Delivered on the existing `org:<id>:incidents` topic rather than a new one, so it shares the board's authorization rule instead of getting a second one to keep in step. | `packages/contracts/src/realtime.ts` |
| 20 | A keypress raises a server event carrying nothing. Position comes from a server-side native; the request id a client echoes back is validated, looked up, and checked against the responder's own membership. Backup is refused while down; sharing your location is NOT, because that is exactly when it matters. | `resources/leoos_bridge/` |
| 26, 43 | The strip sits below panic and above the filters, so no filter can hide somebody asking for help. Kind is stated in words as well as colour and icon. Backup and share are ONE press each — the two-step confirmation panic carries would put a dialog between an officer and the moment they need a hand. | `apps/web/app/(app)/dispatch/field-request-strip.tsx` |
| 45 | A share is a SNAPSHOT, not a track. One that followed you would be a way to obtain continuous tracking of a colleague without `map.track_units` — surveillance wearing a helpful label. | [dispatch §6b](docs/architecture/09-dispatch.md) |

### In-game keybinds

| Rules | Mechanism | Location |
| --- | --- | --- |
| 20 | A keypress raises a server event carrying **nothing** — no position, no identity, no liveness flag. `source` is set by the FiveM runtime; the server reads the rest from natives the client cannot reach. The client's own refusal is a courtesy so the player sees an answer, and is documented as one rather than counted as a check. | `resources/leoos_bridge/client/keybinds.lua` |
| 10, 19, 20 | Liveness is a GAME-WORLD FACT in the same trust class as a coordinate: the game server asserts it, LEOOS records it, and no session-authenticated route has a field for it — `panicSchema` is `.strict()`, so a browser sending `down` gets a 400. Three layers check it and the document says plainly that a wholly compromised game server defeats all three. | [fivem §8](docs/architecture/04-fivem-integration.md), `apps/api/src/modules/fivem/liveness-store.ts` |
| 44 | The two liveness rules point in opposite directions on purpose. EITHER source saying down refuses, because letting `down:false` on an event override recent telemetry would delete the API-side layer entirely. ABSENT information fails open, because refusing on silence would let a telemetry gap suppress somebody's alarm. Both directions are pinned by a test. | `apps/api/test/fivem.test.ts` |
| 23 | A refused panic is audited as `panic.triggered` with outcome `denied` — the same key as a successful one, so "show me refused panics" is one filter. A stream of them is a player hammering a key while dead, or a resource whose check has broken. | `apps/api/src/modules/fivem/fivem.routes.ts` |
| 21, 22 | A liveness transition forces a telemetry send, alongside distance, heading and vehicle. Without it the throttle would swallow it: a player shot — or revived — while standing still would wait up to the ten-second keep-alive, and a revived player's panic button would stay dead for that whole window. | `resources/leoos_bridge/server/collector.lua` |
| 4, 41 | The inbound channel was RAISED before it was built. The contract, the wire format and the resource's consumer had existed since Phase 7 with **no producer** — a channel that looked complete and carried nothing. Push-to-game-host and long-poll were both weighed and rejected in writing before a queue was added to the existing response path. | [fivem §7](docs/architecture/04-fivem-integration.md) |
| 12, 44 | The command set is `notify`, `setBlip`, `clearBlip`, `setWaypoint` — nothing that can move, kick or charge a player. A compromised backend must not become a way to grief a game server. The doc previously showed a `kickUnit` example that was never implemented and that the resource refuses on principle; it is gone. | `resources/leoos_bridge/server/commands.lua` |
| 22 | The queue is bounded and drops the OLDEST past the cap, with a 60-second TTL checked on drain. A game server offline for an hour cannot make the API hold a backlog, and a prompt surfacing four minutes late is confusion rather than help. | `apps/api/src/modules/fivem/command-queue.ts` |
| 30, 45 | `nextIntervalMs` means the telemetry interval on one endpoint and the heartbeat interval on another — an order of magnitude apart. The resource's shared response handler applies it only for the caller that owns the telemetry clock; applying it blindly would quietly drop the map to a tenth of its rate with nothing in any log. Asserted over the wire. | `resources/leoos_bridge/server/transport.lua`, `apps/web/scripts/fivem-check.mjs` |
| 36, 37 | `isDown` is the only game-world question an adapter may answer beyond identity, and it exists because a framework holds a downed player at positive health. It changes nothing organizational, and standalone still ships with a base-native fallback. | `resources/leoos_bridge/server/adapters/standalone.lua` |
| 40 | The Lua had no compiler, no linter and no test — a stray `end` would have been found by a server operator restarting their server. `luac -p` now parses every file as part of `pnpm lint`. | `scripts/check-lua.mjs` |

### Production readiness

| Rules | Mechanism | Location |
| --- | --- | --- |
| 34, 45 | Nothing in the shell asserts a state it cannot observe. The status bar's hard-coded "FiveM not connected" chip — still saying "Bridge lands in Phase 7" two phases after the bridge shipped — is gone; bridge state is reported by `MapSourceStatus`, which is derived from heartbeats that actually arrived. | `apps/web/components/shell/status-bar.tsx` |
| 40, 41 | The browser walkthroughs are release gates, so they have to be RUNNABLE. Their cast and fixtures are provisioned by scripts in the repository rather than assumed to exist in one developer's database, which is how they had been failing on a clean checkout with a `waitForURL` timeout that named nothing. | `packages/db/scripts/setup-ui-cast.mjs`, `setup-records.mjs` |
| 26 | Two comboboxes on the dispatch screen both read "Select a unit…" — one dispatches to a call, one joins a crew — and neither carried a programmatic label, because the caption beside them is a plain span. Both now name themselves. | `apps/web/app/(app)/dispatch/` |
| 43 | Contrast is measured on the STATE THAT RENDERS, not the default one: the unread badge and the audit log's organization chip both escaped the earlier pass because an empty inbox and an unfiltered log do not draw them. Both now use the `*-solid` fills that exist for text on colour. | `apps/web/scripts/a11y-check.mjs` |
| 17, 42 | Deployment, the full environment-variable reference, database setup, API authentication and troubleshooting are documented with placeholders only — and the README no longer describes a product that does not exist. | [OPERATIONS](docs/OPERATIONS.md) |

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

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

# 08 — Implementation Roadmap

Nine phases. Each has explicit exit criteria; a phase is not finished because its
code exists, it is finished because its criteria are demonstrably met.

Sequencing rationale: **authorization comes before features** (Phase 2 before
anything that manages data), because retrofitting a hierarchy rule into existing
CRUD endpoints is how these systems get holes. **The design system comes before
screens** (Phase 3), because rebuilding forty screens to a new table component is
worse than building the table first.

Estimates assume one focused full-stack developer and are ranges, not commitments.

---

## Phase 0 — Foundation ⚑ **schema complete**
*Estimate: 3–5 days*

The database layer of this phase is built: `packages/db` holds the full schema,
two forward-only migrations, idempotent reference-data seeds and 41 tests that
run against a real PostgreSQL instance. Remaining Phase 0 work is the API
scaffold, CI wiring and structured logging.

Monorepo, tooling, and a runnable empty system.

- pnpm workspaces + Turborepo; `apps/web`, `apps/api`, `packages/{db,contracts,authz-core,config}`
- TypeScript strict across the board; ESLint + Prettier; commit hooks
- `docker-compose.yml` — Postgres 16, Redis 7, adminer
- Env schema validation that refuses to boot on a missing secret
- Drizzle configured; first migration; seed runner
- CI: install → typecheck → lint → test → build → **secret scan** (rule 17)
- Structured logging with request-id propagation; health and readiness endpoints
- Error taxonomy and the global error handler

**Exit:** `docker compose up` gives a working stack; `pnpm dev` runs web and API; CI
is green on an empty test suite; a migration can be created, applied, and rolled
forward.

---

## Phase 1 — Authentication & accounts
*Estimate: 1–1.5 weeks*

- `user_account`, `session`, `auth_token`, `user_global_role`, `audit_log` tables
- Argon2id hashing; registration, login, logout
- Opaque session cookies with rotation and the full revocation cascade
- Email verification and password reset flows behind a `MailTransport` interface
  (console transport in dev)
- Rate limiting and progressive lockout on all auth surfaces
- CSRF (SameSite + double-submit + Origin allow-list)
- Audit write helper; append-only privileges applied
- Minimal login/register/reset pages — deliberately unstyled beyond tokens

**Exit:** a user can register, verify, log in, reset a password, and log out;
sessions revoke correctly in all five cascade cases; every auth event is audited;
rate limits are demonstrated by test; auth integration suite passes against real
Postgres.

---

## Phase 2 — Organizations, roles, permissions ⭐
*Estimate: 2–2.5 weeks — the highest-risk phase*

- `organization`, `permission`, `role`, `role_permission`, `organization_member`,
  `member_role`, `member_permission_override`, `organization_lead`
- Permission catalogue in `packages/contracts` + seed + CI drift check
- Seed the six organizations with sensible default rank structures
- `packages/authz-core`: pure `can`, `canManageMember`, `canAssignRole`,
  `canEditRole`, `canGrantPermissions`
- `apps/api/src/authz`: transactional loaders with `FOR UPDATE`, version-keyed cache
- All database triggers and constraints from data-model §8
- Personnel operations: hire, fire, promote, demote, assign/remove role, override
- Organization Lead grant/revoke (global admin only)
- **The test suite described in authorization §B.9**

**Exit:** the full hierarchy matrix passes; property tests hold; concurrency tests
prove no escalation under parallel promote/demote; every attack listed in
authorization §B.3 has a named failing-before/passing-after regression test; a
second reviewer has read the authz kernel line by line.

*This phase does not ship without that review. Everything downstream depends on it
being right.*

---

## Phase 3 — Application shell & design system ✅ **COMPLETE**
*Estimate: 1–1.5 weeks*

Delivered ahead of Phases 1 and 2 at the product owner's direction, so that every
later module has a design system to extend rather than inventing its own. The
screens built here are presentation only: they render fixture data, perform no
mutations, and state plainly where a capability is not yet implemented.

- Token layer, typography, dark theme
- App shell: sidebar (server-filtered by permission), top bar, status bar
- Organization switcher and active-org context
- `DataTable` (virtualised, sortable, URL-persisted), `StatusChip`, `PriorityBadge`,
  `OrgBadge`, `Panel`, `SplitLayout`, `ConfirmDialog`, `EmptyState`, `LiveIndicator`
- Command palette skeleton
- `AsyncBoundary` / `Skeleton` / `ErrorState` / `EmptyState` — the four-state
  convention (rule 26), enforced by lint before any screen is built on it
- Strict CSP; `dangerouslySetInnerHTML` lint ban
- Personnel, roles, and organization screens built on the new components — the
  first real consumers, which is how the component set gets validated

**Exit:** navigation reflects permissions with no client-side leakage of hidden
routes; personnel and role management are fully usable including hierarchy-aware
per-row actions; the design passes contrast and keyboard-navigation review.

---

## Phase 4 — Persons, vehicles & search
*Estimate: 1.5–2 weeks*

- `person`, `person_flag`, `warrant`, `criminal_charge`, `statute`, `license`,
  `medical_record`, `vehicle`, `vehicle_flag`
- CRUD with permission and field-level visibility (medical gated separately)
- Soft deletion (ADR-0008): `deleted_at` columns, partial unique indexes,
  default-filtering repository helper, archive/restore flows, `admin.purge`
- Trigram indexes; cross-entity search with per-entity permission filtering
- **Read auditing** on person, medical, and warrant views
- Person and vehicle detail pages with flag banners

**Exit:** search returns persons and vehicles filtered by permission; an officer
without `persons.medical.view` cannot obtain medical fields through any endpoint
(proved by test, not by inspection); every sensitive read appears in the audit log;
archiving a vehicle frees its plate for re-registration and restoring it reports a
conflict if the plate was reissued; no query returns archived rows without an
explicit opt-in.

---

## Phase 5 — Dispatch & real-time
*Estimate: 2–2.5 weeks*

- `duty_status`, `duty_status_type`, `unit`, `unit_member`, `incident`,
  `incident_type`, `incident_assignment`, `incident_log`, `incident_link`,
  `panic_event`
- Duty status changes; patrol create/join/leave/disband with the one-active-unit
  database constraint
- Incident lifecycle, assignment, timeline, closure
- Panic activation, broadcast, acknowledgement
- WebSocket hub: topic authorization, snapshot+delta, heartbeats, reconnect
- Redis pub/sub fan-out; post-commit publishing
- Permission-change re-evaluation of live subscriptions
- Dispatch console and dashboard screens

**Exit:** two browsers see each other's status, unit, and incident changes within
one second without reload; a revoked session's socket closes; a demoted user loses
the topics they no longer qualify for while connected; the dispatch console is
usable end to end on one 1080p display.

---

## Phase 6 — Map
*Estimate: 1.5–2 weeks · **blocked on tile licensing***

- Tile generation script and hosted pyramid
- Calibrated coordinate transform with landmark fixtures
- Leaflet + `CRS.Simple` base map, layer switching
- Canvas unit overlay with interpolation, heading, org colour, status shape
- Incident and marker layers; selection panel; follow mode; filters; shortcuts
- Server-side per-subscriber visibility filtering
- Position history and playback behind `map.history`

**Exit:** 300 synthetic units render at 60 fps; a known in-game landmark lands at
its correct map position; covert units are absent from an unprivileged
subscriber's payload (verified at the wire, not the UI); an 8-hour soak shows no
material memory growth.

---

## Phase 7 — FiveM bridge
*Estimate: 1.5–2 weeks*

- `game_server`, `game_server_credential`, `game_server_state`, `game_identity`
- HMAC verification middleware: skew window, nonce cache, monotonic sequence
- `/handshake`, `/heartbeat`, `/telemetry`, `/events`, `/identity/claim`
- Ingest pipeline: validation, sanity filters, identity resolution, enrichment,
  Redis write, downsampler, delta emission
- Three-level offline detection
- Command channel with at-most-once delivery and acknowledgement
- `resources/leoos_bridge` Lua resource with the **`standalone` adapter** (base
  natives only — no framework assumed, rule 37); ESX/QBCore adapters only if the
  target server runs them
- Admin UI for servers, credentials, rotation, anomaly counters

**Exit:** a real FiveM server drives live units onto the map; killing the game
server clears its units within 30 s; a replayed request is rejected; a tampered
body is rejected; a payload asserting an organization is ignored and the org still
resolves from the database; key rotation completes with no gap in telemetry.

---

## Phase 8 — Administration, audit & hardening
*Estimate: 1.5–2 weeks*

- Global admin: user management, org management, org-lead grants, game servers
- Audit log viewer with filtering by actor, org, action, entity, and outcome
- Lookup-volume reporting per user (A5 mitigation)
- TOTP 2FA, enforced for high-risk permission holders
- Alerting on high-risk and denied actions
- Retention jobs: position history, expired tokens, old sessions
- Metrics (Prometheus), tracing, dashboards
- Backup and restore procedure, rehearsed
- Load test: 300 units, 40 operators
- Full security review against risks §A; penetration testing of the authz surface

**Exit:** every risk in §A has either a mitigation demonstrated by test or an
explicit written acceptance; backup restore has been performed successfully at
least once; load targets are met; the security review has no open critical or high
findings.

---

## Phase 9 — Polish & launch
*Estimate: 1 week*

Operator documentation, admin runbook, FiveM server-owner setup guide, onboarding
flow, seed data for a demo environment, deployment automation, staged rollout with
a pilot organization.

---

## Phase completion gate (rule 40)

Independently of each phase's own exit criteria, no phase is finished until:

1. `pnpm typecheck && pnpm lint && pnpm test` is green across the workspace — not
   only the packages that changed.
2. Any change touching authorization, sessions, ingest verification, or
   serialization has an added or updated regression test (rule 32). A test that was
   loosened to pass is a failed gate (rule 33).
3. Migrations apply cleanly forward on a copy of the previous phase's database
   (rule 48).
4. Any integration still behind a mock is named as mocked in the phase report
   (rules 35, 45). "Implemented" is reserved for code that runs against the real
   dependency.
5. The architecture documents are updated where implementation diverged from them
   (rule 42).

---

## Summary

| Phase | Focus | Estimate | Blocking dependency |
| --- | --- | --- | --- |
| 0 | Foundation | 3–5 d | — |
| 1 | Auth & accounts | 1–1.5 w | 0 |
| 2 | **Orgs, roles, permissions** | 2–2.5 w | 1 |
| 3 | Shell & design system ✅ | 1–1.5 w | — (built first) |
| 4 | Persons & vehicles | 1.5–2 w | 3 |
| 5 | Dispatch & real-time | 2–2.5 w | 3 |
| 6 | Map | 1.5–2 w | 5 · **tile licence** |
| 7 | FiveM bridge | 1.5–2 w | 6 |
| 8 | Admin, audit, hardening | 1.5–2 w | 7 |
| 9 | Polish & launch | 1 w | 8 |

**Total: roughly 13–17 weeks** for one full-stack developer.

Phases 4 and 5 are independent of each other once Phase 3 lands and can be
parallelised across two developers. Phase 6's tile-licensing question should be
resolved during Phase 0 — it is a week of lead time on a legal answer, not a
technical one, and it is the only external blocker in the plan.

### Deliberately deferred beyond v1
Multi-server map merging · in-game MDT/NUI panel · report writing and citations ·
shift scheduling and timesheets · Discord integration · mobile-native client ·
i18n · voice/radio integration.

Each is a reasonable feature; none is required for a working dispatch platform, and
including them now would double Phase 5.

# LEOOS — Law Enforcement & Emergency Operations System

A web-based emergency-services management and dispatch platform for a GTA V FiveM
roleplay server. LEOOS is built to feel like a professional emergency operations
console — dense, fast, dark and authoritative — not a generic admin dashboard.

Six organizations (PD, MD, FIB, Army, ICE, Mechanic) share one installation.
Organizations, roles and permissions are **database rows**, not code: adding a
seventh agency is a seed insert, never a deployment of new logic.

---

## What is actually built

Every row below is implemented **and** covered by the automated tests named
beside it. Nothing is listed as complete on the strength of a screen existing.

There is **no CI pipeline in this repository** — the suites are run locally with
`pnpm test`. Wiring them into CI is the first item under *Recommended next
steps* in the [project report](docs/PROJECT-REPORT.md).

| Area | State | Evidence |
| --- | --- | --- |
| Authentication | Registration, verification, login, sessions, password reset, lockout, account disabling | `apps/api/test/auth.test.ts` (33) |
| Authorization kernel | Hierarchy H1–H8, role mutation, global administration | `packages/authz-core/test/` (116) |
| Organizations & leads | Read, edit, archive, lead grant/revoke | `organizations.test.ts` (23) |
| Roles & permissions | Create, edit, reorder, archive, permission sets, per-member overrides | `roles.test.ts`, `personnel.test.ts` (67) |
| Personnel | Hire, promote, demote, assign roles, terminate, callsigns | `personnel.test.ts` |
| Persons & vehicles | Registers, drawers, flags, warrants, medical/criminal scoping | `records.test.ts` (38) |
| Search | Cross-entity search with per-permission redaction | `search.test.ts` (24) |
| Dashboard | Live counts, alerts, honest "not measured" metrics | `dashboard.test.ts` (25) |
| Dispatch | Incidents, units, statuses, assignments, panic, timeline | `dispatch.test.ts` (61) |
| Live map | Canvas renderer, clustering, filters, freshness, panic locator | `map.test.ts` (41) + `map-cluster/viewport/filter` (contracts) |
| Real-time | WebSocket hub, ticket handshake, per-delivery authorization | `realtime.test.ts` (40) |
| FiveM ingest | HMAC signing, replay/skew/sequence, telemetry, events, admin | `fivem.test.ts` (51) |
| Notifications | Types, recipients, centre, preferences, panic surfacing | `notifications.test.ts` (39) |
| Global administration | User register, capabilities, audit log, system status | `admin.test.ts` (39) |
| Security regressions | Seven audited findings | `security.test.ts` (40) |
| End-to-end lifecycle | Register → org → roles → hire → promote → dispatch → panic → terminate → archive | `lifecycle.test.ts` (42) |

**911 automated tests** across four packages, plus **nine browser walkthroughs**
that drive a real Chromium against running servers.

### Not built

- **Redis.** The nonce store, ticket store, live position store, actor cache and
  identity cache are all in-process. Correct on one node; each multiplies or
  fragments across instances. This is the single largest gap between the
  codebase and horizontal scaling.
- **Mail delivery.** Every reset and verification path runs against a console
  transport that prints and does not send. The admin system screen says so.
- **`position_history` has no writer.** The table, its index and the replay query
  exist and are benchmarked; no application code writes to it yet.
- **Map tiles.** The canvas renders over a solid base; the GTA tile pyramid is
  not shipped in this repository.

---

## Quick start

```bash
docker compose up -d                          # Postgres 16 (+ Redis, unused today)
pnpm install

cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
# set the SAME value for INTERNAL_API_TOKEN in both files:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

pnpm db:migrate                               # schema
pnpm db:seed                                  # permissions, statuses, orgs, roles

pnpm dev:api                                  # http://localhost:3001
pnpm dev:web                                  # http://localhost:3000
```

Register at `/register`. The console transport prints the verification link to
the **API log** — it does not send email. A verified account has no organization
membership by design: registration grants nothing, and you land on a holding
screen until an administrator assigns you.

To get an administrator on a fresh database:

```bash
psql "$DATABASE_URL" -c "
  INSERT INTO user_global_role (user_id, capability)
  SELECT id, 'global_admin' FROM user_account WHERE username = 'your.username';
  UPDATE user_account SET permission_version = permission_version + 1
   WHERE username = 'your.username';"
```

The version bump matters: identity resolution is cached on it, so without it the
grant takes up to five seconds to apply instead of applying on the next request.

---

## Documentation

| Topic | Where |
| --- | --- |
| **Project report — what is built, what is not, what is next** | [`docs/PROJECT-REPORT.md`](docs/PROJECT-REPORT.md) |
| **Operations — deploy, configure, troubleshoot** | [`docs/OPERATIONS.md`](docs/OPERATIONS.md) |
| **FiveM resource — install, configure, endpoints** | [`resources/leoos_bridge/README.md`](resources/leoos_bridge/README.md) |
| Engineering rules and how each is enforced | [`CLAUDE.md`](CLAUDE.md) |
| Architecture, stack, module map | [`docs/architecture/00-overview.md`](docs/architecture/00-overview.md) |
| Data model — entities, constraints, triggers | [`docs/architecture/01-data-model.md`](docs/architecture/01-data-model.md) |
| Authorization — permissions, hierarchy, kernel | [`docs/architecture/02-authorization.md`](docs/architecture/02-authorization.md) |
| Real-time — protocol, topics, scaling | [`docs/architecture/03-realtime.md`](docs/architecture/03-realtime.md) |
| FiveM integration — bridge, ingest, anti-spoofing | [`docs/architecture/04-fivem-integration.md`](docs/architecture/04-fivem-integration.md) |
| Map — coordinates, tiles, unit layer | [`docs/architecture/05-map.md`](docs/architecture/05-map.md) |
| Design system — tokens, layout, components | [`docs/architecture/06-design-system.md`](docs/architecture/06-design-system.md) |
| Risks and mitigations | [`docs/architecture/07-risks.md`](docs/architecture/07-risks.md) |
| Dispatch · Dashboard · Administration · Notifications | [`09`](docs/architecture/09-dispatch.md) · [`10`](docs/architecture/10-dashboard.md) · [`11`](docs/architecture/11-administration.md) · [`12`](docs/architecture/12-notifications.md) |
| Security audit — findings, fixes, regression tests | [`docs/architecture/13-security-audit.md`](docs/architecture/13-security-audit.md) |
| Performance — measurements and rejected optimisations | [`docs/architecture/14-performance.md`](docs/architecture/14-performance.md) |
| Testing — coverage map and remaining risks | [`docs/architecture/15-testing.md`](docs/architecture/15-testing.md) |
| Architecture Decision Records | [`docs/adr/`](docs/adr/) |

---

## Workspace

```
apps/web            Next.js 16 — UI, shell, screens; holds the session cookie
apps/api            Fastify 5 — auth, domain logic, real-time; the only DB access
packages/contracts  permissions, status catalogues, coordinate transform, DTOs
packages/authz-core pure hierarchy and permission decision functions
packages/db         Drizzle schema, migrations, seeds
resources/          the leoos_bridge FiveM resource
docs/               architecture, ADRs, operations
```

The web tier **never touches the database**. It holds the session cookie and
forwards to the API, which re-derives authority on every request and decides
every rule inside the transaction that performs the change
([ADR-0001](docs/adr/0001-split-web-and-api.md)).

---

## Tests and checks

```bash
pnpm test                                    # 911 tests, all packages
pnpm typecheck                               # all five packages
pnpm lint

# Browser walkthroughs — need the API and web running (see docs/OPERATIONS.md)
cd apps/web
node scripts/a11y-check.mjs                  # contrast, focus, labels, structure
node scripts/visual-check.mjs                # 4 viewports, overflow, console errors
node scripts/dispatch-check.mjs              # and eight more
```

The API suite runs sequentially against one database and **must not be run
concurrently with another suite** — `resetAccounts` deletes every test session,
so a parallel run loses its own sessions and fails with a cascade of 401s.

---

## Engineering rules

[`CLAUDE.md`](CLAUDE.md) holds fifty binding rules and — more usefully — the
mechanism that enforces each one. A rule with no enforcement point is a wish, so
the table names the file, the test or the database trigger that actually holds
it.

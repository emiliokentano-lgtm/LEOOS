# 00 — Architecture Overview

## 1. Repository inspection result

The repository was empty at the time of this analysis:

- No commits on any branch, no remote refs, no working-tree files.
- No `package.json`, no lockfile, no build tooling, no CI, no container definitions.
- No existing frontend, backend, database schema, ORM, auth system, or API surface.

**Conclusion:** greenfield. There is no existing functionality to preserve or
extend, so this document proposes a full architecture rather than an extension
plan. Every stack choice below is therefore a first choice, made against the
project's constraints rather than inherited from existing code.

Environment available on the build host: Node 22.22, pnpm 10.33, Python 3.11,
Docker 29, PostgreSQL 16 client.

---

## 2. What makes this system non-generic

Four requirements drive nearly every decision. They are worth stating up front
because they are what separates LEOOS from a CRUD dashboard:

1. **Hierarchical authorization is a correctness problem, not a feature.** A user
   must never manage anyone at or above their own rank, never assign a role above
   their own level, and never grant a permission they do not themselves hold. This
   is adversarial logic with race conditions. It gets a dedicated, heavily tested
   kernel module and it runs inside the mutating transaction.
2. **High-frequency, low-value telemetry meets low-frequency, high-value records.**
   Unit positions arrive at ~1 Hz per player and are worthless five seconds later.
   Personnel and incident records are permanent and audited. These two workloads
   must not share a storage strategy.
3. **The game server is a semi-trusted peer, not a client.** It authenticates as a
   machine, its payloads are signed, and it is never allowed to assert who someone
   is or what rank they hold.
4. **Multi-tenancy by organization is baked in.** Six orgs today, more later, with
   asymmetric visibility (MD sees medical history, PD does not; FIB units may be
   hidden from the shared map).

---

## 3. Recommended stack

| Layer | Choice | Why this and not the obvious alternative |
| --- | --- | --- |
| Language | TypeScript (strict, `noUncheckedIndexedAccess`) end to end | One type vocabulary across UI, API, and contracts. Shared Zod schemas mean a permission key or incident status can't drift between layers. |
| Frontend | Next.js 15 (App Router) + React 19 | Server Components let permission-gated navigation and tables render without shipping the permission model to the browser. Not an SPA-only build: we want server-rendered dense tables. |
| Styling | Tailwind CSS v4 + a small hand-built primitive set on Radix UI | Radix gives accessible behaviour for menus/dialogs/tooltips; the visual layer stays ours. **Not** a full component kit — stock kits produce exactly the "generic admin dashboard" look the brief rejects. |
| Client data | TanStack Query + a thin WebSocket cache-patch bridge | Query owns REST cache; live events patch the same cache. Avoids a second parallel state store. |
| Backend | Fastify 5 + TypeScript | Fast, first-class JSON-schema validation, real plugin encapsulation for module boundaries, mature WebSocket support. NestJS was considered and rejected as heavier than this team size needs; bare Express was rejected for lacking validation and lifecycle structure. |
| Database | PostgreSQL 16 | Non-negotiable: we rely on transactions, row locking, CHECK constraints, partial unique indexes, JSONB audit diffs, and table partitioning. |
| ORM | Drizzle ORM + SQL migrations | Chosen over Prisma specifically because the brief mandates database-level constraints. Drizzle expresses CHECK constraints, partial unique indexes, `FOR UPDATE` locking, and CTEs natively; Prisma pushes those into hand-maintained raw SQL alongside its own schema. See [ADR-0002](../adr/0002-drizzle-over-prisma.md). |
| Cache / bus | Redis 7 | Three jobs: ephemeral live-unit state, pub/sub fan-out between API instances, and rate limiting. Justified as a dependency because Postgres would be actively wrong for per-tick position writes. |
| Real-time | Native WebSocket via `@fastify/websocket`, custom typed protocol | Not Socket.IO: we do not need its fallbacks, and we do need per-topic authorization we control. See [ADR-0003](../adr/0003-websocket-over-socketio.md). |
| Auth | Own implementation: Argon2id + opaque server-side sessions | Not Auth.js (OAuth-centric, awkward around custom org/rank models), not Lucia (upstream discontinued as a library). Opaque DB-backed sessions are instantly revocable — mandatory when a firing must end access immediately. See [ADR-0004](../adr/0004-opaque-sessions.md). |
| Map | Leaflet with `CRS.Simple` + canvas overlay for units | GTA's map is a flat, non-geographic raster pyramid. Leaflet's `CRS.Simple` handles that in a few lines; MapLibre requires fighting a geographic projection. Unit markers render on a single canvas layer, not as DOM markers. See [ADR-0005](../adr/0005-leaflet-crs-simple.md). |
| FiveM bridge | Lua resource, server-side only, outbound HMAC-signed HTTPS | Outbound-only means no inbound port on the game server and no firewall work for server operators. |
| Monorepo | pnpm workspaces + Turborepo | Two deployables plus shared contract packages. Turborepo only for task caching; no custom build framework. |
| Tests | Vitest (unit/integration) + Playwright (E2E) + Testcontainers (real Postgres) | The authz kernel must be tested against a real database because its guarantees depend on transactions and locking. |

### [CONFIRM] Decisions needing product sign-off

1. **Deployment target.** The architecture assumes a self-hosted Linux VPS with
   Docker Compose (or a single Kubernetes namespace). This is required — a
   serverless host cannot hold long-lived WebSocket connections cheaply. Confirm
   we control a VPS.
2. **Map tile source.** We need a GTA V map raster tile pyramid. Confirm which
   asset set is used and that its licence permits hosting. This is a legal
   question, not a technical one, and it blocks Phase 6.
3. **FiveM framework.** *No longer blocking.* Per rule 37 no framework is assumed:
   the bridge ships a `standalone` adapter using base natives only, and ESX/QBCore
   adapters are added behind the same interface if the server actually runs them.
   Still worth telling us, so we know whether to build a second adapter.
4. **Single game server or multiple?** The schema supports many; confirm whether
   the map must merge units from several servers.
5. **Retention policy.** How long do we keep position history and audit logs?
   Default proposal: positions 7 days downsampled, audit logs indefinitely.

---

## 4. System topology

```
                        ┌──────────────────────────────┐
   Browser  ───HTTPS───▶│  apps/web  (Next.js 15)      │
            ◀──────────  │  RSC pages · BFF route       │
                        │  handlers · session cookie   │
                        └──────────┬───────────────────┘
                                   │ internal HTTP (service token)
                                   ▼
   Browser  ══WSS═══════▶┌──────────────────────────────┐
            (live feed)  │  apps/api  (Fastify 5)       │
                         │  ┌────────────────────────┐  │
   FiveM    ──HTTPS─────▶│  │ authz kernel           │  │
   server    (HMAC)      │  │ domain modules         │  │
            ◀──ack────── │  │ realtime hub           │  │
                         │  │ ingest gateway         │  │
                         │  └────────────────────────┘  │
                         └────┬──────────────────┬──────┘
                              │                  │
                     ┌────────▼───────┐   ┌──────▼──────┐
                     │  PostgreSQL 16 │   │   Redis 7   │
                     │  system of     │   │  live units │
                     │  record, audit │   │  pub/sub    │
                     │                │   │  ratelimit  │
                     └────────────────┘   └─────────────┘
```

**Why two deployables and not one Next.js app.** Position ingest and WebSocket
fan-out are long-lived, high-frequency, and operationally distinct from page
rendering. Splitting them means a traffic spike from the game server cannot
degrade the operator UI, the API can be scaled independently, and the FiveM bridge
never touches the web tier. The cost is one extra service and an internal auth
hop — acceptable, and explicitly not premature abstraction, because the second
workload exists on day one.

The web tier holds the session cookie and proxies to the API with a short-lived
service token carrying the resolved user identity. The API is the **only** thing
that talks to Postgres. There is exactly one authorization implementation.

---

## 5. Repository layout

```
leoos/
├── apps/
│   ├── web/                     # Next.js 15 — UI + BFF
│   │   ├── app/
│   │   │   ├── (auth)/          # login, register, reset — no app shell
│   │   │   └── (app)/           # authenticated shell + sidebar
│   │   │       ├── dashboard/  search/  map/  dispatch/
│   │   │       ├── persons/  vehicles/  personnel/
│   │   │       ├── organization/  roles/
│   │   │       └── admin/       # users, orgs, audit
│   │   ├── components/          # ui/ primitives, domain widgets
│   │   └── lib/                 # api client, ws client, session
│   └── api/                     # Fastify 5
│       ├── src/
│       │   ├── modules/         # one folder per bounded context
│       │   │   ├── auth/  accounts/  organizations/  roles/
│       │   │   ├── personnel/  persons/  vehicles/
│       │   │   ├── dispatch/  incidents/  units/
│       │   │   ├── map/  audit/
│       │   │   └── fivem/       # ingest gateway
│       │   ├── authz/           # ⭐ authorization kernel
│       │   ├── realtime/        # ws hub, topics, redis bridge
│       │   ├── plugins/         # db, redis, auth, ratelimit, errors
│       │   └── lib/             # ids, hashing, hmac, clock
│       └── test/
├── packages/
│   ├── db/                      # Drizzle schema, migrations, seeds
│   ├── contracts/               # Zod DTOs, permission catalogue,
│   │                            #   WS event union, status enums
│   ├── authz-core/              # pure hierarchy/permission functions
│   └── config/                  # env parsing, shared tsconfig/eslint
├── resources/
│   └── leoos_bridge/            # FiveM Lua resource
├── docs/
│   ├── architecture/  adr/
├── docker-compose.yml
└── turbo.json
```

`packages/authz-core` is deliberately **pure** — no database, no I/O. It contains
the hierarchy comparison and permission-subset functions so they can be
exhaustively property-tested in milliseconds. `apps/api/src/authz` wraps it with
data loading, caching, and transactional locking.

`packages/contracts` is the single source of truth for the permission catalogue,
every status enum, and the WebSocket event union. If a permission key exists, it
exists there first; the database seed and the UI both read from it.

---

## 6. Module map

### Platform modules
- **config** — startup-time env validation; the process refuses to boot on a
  missing secret rather than failing at first use.
- **db** — Drizzle client, transaction helper, connection pool.
- **audit** — append-only write path, invoked by every mutating handler through a
  single helper so auditing cannot be forgotten silently.
- **errors** — typed error taxonomy mapped to HTTP codes; authorization failures
  are indistinguishable from not-found for resources the actor cannot see.

### Identity modules
- **auth** — registration, login, logout, session lifecycle, verification tokens,
  password reset, optional TOTP, lockout and rate limiting.
- **accounts** — user account administration, global capability grants.
- **game-identity** — links FiveM identifiers (license/steam/discord) to accounts
  and persons. This is the *only* trusted mapping from a game player to a LEOOS user.

### Organization modules
- **organizations** — org CRUD, settings, branding, activation.
- **roles** — org-scoped and global roles, hierarchy levels, permission sets.
- **personnel** — memberships, hiring, firing, promotion, demotion, callsigns,
  badge numbers. Every operation routes through the authz kernel.
- **org-leads** — the explicit Organization Lead capability, grantable only by a
  global administrator.

### Records modules
- **persons** — citizen records, flags, warrants, licences, criminal history.
- **vehicles** — registrations, ownership, org fleets, flags (stolen/impounded/BOLO).
- **medical** — MD-scoped health records with field-level visibility.
- **search** — cross-entity query with per-entity permission filtering; every
  search that returns a person or vehicle is audited.

### Operations modules
- **duty-status** — a member's current operational status.
- **units** — patrols: create, join, leave, disband, callsign assignment.
- **incidents** — creation, typing, priority, assignment, timeline, closure.
- **panic** — panic activation, broadcast, acknowledgement.
- **map** — live unit snapshot, markers, position history playback.

### Integration modules
- **realtime** — WebSocket hub, topic authorization, Redis fan-out.
- **fivem** — ingest endpoints, HMAC verification, heartbeat, offline detection,
  telemetry validation and rate limiting.

---

## 7. Cross-cutting rules (binding on all implementation)

1. **Every mutation is authorized inside its own transaction**, after acquiring a
   row lock on the actor's membership. Checking before opening the transaction is
   a race, and this system has adversarial users.
2. **Organization scope is never read from the request body.** It is derived from
   the resource being acted upon or from the actor's resolved membership. A
   request that supplies `organizationId` for anything other than a create is a
   bug.
3. **Every request carries a request ID**, propagated into logs and audit rows.
4. **Every mutating endpoint writes exactly one audit row** with before/after
   JSONB diffs. Reads of sensitive records (persons, medical, warrants) are also
   audited — real law-enforcement systems must answer "who looked up whom".
5. **Validation is schema-first.** Every route declares a Zod schema from
   `packages/contracts`; unvalidated `request.body` access is a lint error.
6. **The frontend's permission checks exist only to hide UI.** They are never the
   enforcement point, and the API assumes the client is hostile.
7. **No hardcoded organization keys or role names in logic.** `if (org.key === 'PD')`
   is prohibited; behaviour differences are expressed as organization settings or
   permissions.

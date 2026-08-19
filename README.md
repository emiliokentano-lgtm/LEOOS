# LEOOS — Law Enforcement & Emergency Operations System

A web-based emergency-services management and dispatch platform for a GTA V FiveM
roleplay server. LEOOS is designed to feel like a real professional emergency
operations console — dense, fast, dark, and authoritative — not a generic admin
dashboard.

## Status

**Phases 1 and 3 complete; database layer of Phase 0 complete.**

- **Authentication is real.** Registration, verification, login, logout, sessions,
  password reset and account status all work end to end against PostgreSQL.
- **The domain schema is real.** 42 tables with constraints, triggers and seeds.
- **The design system is real.** Component library and application shell.

Still fixtures: operational screens (persons, vehicles, dispatch, map) render
demo data from `apps/web/mocks`, badged as such in the top bar. Mail is behind a
console transport that **delivers nothing** and says so. The FiveM bridge and the
real-time layer do not exist yet.

Outstanding: Phase 2 (personnel and role mutation endpoints on top of the
authorization kernel), Phases 4–9.

## Running it

```bash
docker compose up -d                  # Postgres + Redis
pnpm install
pnpm db:migrate && pnpm db:seed       # schema + reference data

cp apps/api/.env.example apps/api/.env    # set INTERNAL_API_TOKEN
cp apps/web/.env.example apps/web/.env    # same token

pnpm dev:api                          # http://localhost:3001
pnpm dev:web                          # http://localhost:3000
```

Register an account at `/register`. The console transport prints the verification
link to the API log — it does not send email. A verified account has **no
organization membership**, which is deliberate: registration grants nothing, and
you land on a holding screen until an administrator assigns you.

`NEXT_PUBLIC_LEOOS_DEMO=1` enables the fixture data and the "Demo data" badge in
the top bar. Without it the screens render empty — there is nothing else to show
them yet.

Useful routes: `/dashboard`, `/dispatch`, `/map`, `/design` (the living design
system reference), `/login`.

```bash
pnpm typecheck
pnpm --filter @leoos/web lint
pnpm --filter @leoos/web visual-check   # needs a running server
```

## Workspace

```
apps/web            Next.js 16 — UI, shell, screens; holds the session cookie
apps/api            Fastify 5 — auth, domain logic; the only DB access
packages/contracts  permissions, status catalogues, coordinate transform
packages/authz-core pure hierarchy and permission decision functions
packages/db         Drizzle schema, migrations, seeds
docs/               architecture and ADRs
```

## Tests

```bash
pnpm test    # 114 tests: 31 authz kernel, 41 schema, 42 auth/API
```

The schema suite drops and recreates the database, so run it against a
disposable instance and not while the API is running.

## Supported organizations (data-driven, not hardcoded)

Police Department (PD) · Medical Department (MD) · Federal Investigation Bureau (FIB)
· Army · Immigration and Customs Enforcement (ICE) · Mechanic

Organizations are database entities. Adding a seventh organization is a row insert
plus a role/permission seed — never a code change.

## Engineering rules

[`CLAUDE.md`](CLAUDE.md) holds the project-wide engineering rules that bind every
implementation phase, together with the mechanism that enforces each one.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/architecture/00-overview.md`](docs/architecture/00-overview.md) | System architecture, stack, module map, repo layout |
| [`docs/architecture/01-data-model.md`](docs/architecture/01-data-model.md) | Every database entity, relationships, constraints |
| [`docs/architecture/02-authorization.md`](docs/architecture/02-authorization.md) | Permissions, roles, hierarchy rule, authz kernel |
| [`docs/architecture/03-realtime.md`](docs/architecture/03-realtime.md) | WebSocket protocol, topics, presence, scaling |
| [`docs/architecture/04-fivem-integration.md`](docs/architecture/04-fivem-integration.md) | Bridge resource, ingest API, HMAC auth, anti-spoofing |
| [`docs/architecture/05-map.md`](docs/architecture/05-map.md) | GTA V map, coordinate transform, tile pipeline, unit layer |
| [`docs/architecture/06-design-system.md`](docs/architecture/06-design-system.md) | Visual language, tokens, layout, component inventory |
| [`docs/architecture/07-risks.md`](docs/architecture/07-risks.md) | Security risks, technical risks, mitigations |
| [`docs/architecture/08-roadmap.md`](docs/architecture/08-roadmap.md) | Phased implementation plan with exit criteria |
| [`docs/adr/`](docs/adr/) | Architecture Decision Records |
| [`CLAUDE.md`](CLAUDE.md) | Binding engineering rules and their enforcement points |

## Open decisions

Decisions marked **[CONFIRM]** in the overview need a product owner sign-off before
Phase 0 starts. Everything else has a recommended default and a stated rationale.

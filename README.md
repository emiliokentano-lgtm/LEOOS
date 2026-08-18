# LEOOS — Law Enforcement & Emergency Operations System

A web-based emergency-services management and dispatch platform for a GTA V FiveM
roleplay server. LEOOS is designed to feel like a real professional emergency
operations console — dense, fast, dark, and authoritative — not a generic admin
dashboard.

## Status

**Phase 3 (design system & application shell): complete.** The visual foundation,
component library, application shell and screen layouts exist and run. There is
**no backend**: every screen renders fixture data from `apps/web/mocks`, no
mutation is performed, and authentication is not implemented. Screens say so
explicitly rather than faking success.

Phases 0–2 (foundation, auth, authorization kernel) are still outstanding.

## Running it

```bash
pnpm install
NEXT_PUBLIC_LEOOS_DEMO=1 pnpm dev     # http://localhost:3000
```

`NEXT_PUBLIC_LEOOS_DEMO=1` enables the fixture data and the "Demo data" badge in
the top bar. Without it the screens render empty — there is nothing else to show
them yet.

Useful routes: `/dashboard`, `/dispatch`, `/map`, `/design` (the living design
system reference), `/login`.

```bash
pnpm --filter @leoos/web typecheck
pnpm --filter @leoos/web lint
pnpm --filter @leoos/web visual-check   # needs a running server
```

## Workspace

```
apps/web            Next.js 16 — UI, shell, screens
packages/contracts  permissions, status catalogues, coordinate transform
docs/               architecture and ADRs
```

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

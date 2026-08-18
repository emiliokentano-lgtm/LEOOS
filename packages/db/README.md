# @leoos/db

The LEOOS database schema, migrations and seeds. Drizzle ORM on PostgreSQL 16.

`apps/api` owns the single client instance. **`apps/web` has no database access
at all** ([ADR-0001](../../docs/adr/0001-split-web-and-api.md)) — if this package
is ever imported there, that is the bug.

## Quick start

```bash
# a disposable local Postgres
docker run -d --name leoos-pg -p 5432:5432 \
  -e POSTGRES_USER=leoos -e POSTGRES_PASSWORD=leoos -e POSTGRES_DB=leoos \
  postgres:16-alpine

cp .env.example .env
pnpm migrate     # apply migrations
pnpm seed        # baseline reference data (idempotent, production-safe)
pnpm seed:demo   # + fabricated fixtures — never in production
pnpm test        # 41 tests against a real database
```

## Commands

| Command | Effect |
| --- | --- |
| `pnpm generate` | Generate a migration from schema changes |
| `pnpm migrate` | Apply pending migrations (forward only) |
| `pnpm seed` | Permissions, statuses, incident types, the six organizations |
| `pnpm seed:demo` | Baseline + demo fixtures; refuses to run in production |
| `pnpm test` | Schema, constraint and query-plan tests |

## Layout

```
src/schema/          one module per bounded context
  _shared.ts         enums, column builders, citext, soft-delete helpers
  identity.ts        user_account, session, auth_token, game_identity
  organization.ts    organization, role, permission, membership   ← authorization model
  person.ts          person, flags, warrants, charges, licences, medical
  vehicle.ts         vehicle, vehicle_flag
  dispatch.ts        operational_status, unit, incident, panic, map markers
  integration.ts     game_server + credentials (FiveM)
  audit.ts           audit_log + the canonical action catalogue
  notification.ts    notification
src/seed/            reference data (from @leoos/contracts) + demo fixtures
migrations/          0000_init.sql, 0001_invariants.sql
test/                schema, constraint and query-plan tests
```

## Conventions

**Hierarchy.** `role.hierarchy_level` is 1–100 and **higher means more senior**.
A member's effective level is the **maximum** across their roles, never the sum.
Comparison is **strictly greater-than**, so equal ranks are mutually immune —
two lieutenants cannot manage each other. See
[ADR-0007](../../docs/adr/0007-hierarchy-as-integer-level.md).

**Soft deletion.** Operational records are archived, not erased
([ADR-0008](../../docs/adr/0008-soft-deletion.md)). Every soft-deletable table
carries `deleted_at`, `deleted_by` and a required `deletion_reason`, and every
natural-key unique index is **partial** (`WHERE deleted_at IS NULL`) so an
archived plate or organization key does not stay consumed forever.

**Identifiers.** `uuid` v7 via a `uuidv7()` function created in the first
migration. Time-sortable, so inserts stay sequential in the B-tree instead of
scattering the way v4 does. The 12 `rand_a` bits carry sub-millisecond precision
(RFC 9562 §6.2 method 3), so ids created in a burst still sort in creation order.

**Case sensitivity.** Every natural key a human types — email, username, plate,
callsign, organization key — is `citext`. Otherwise `LSPD0412` and `lspd0412` are
two different plates.

**Migrations are forward only.** Reversing a schema change is a new migration
written deliberately, not an automated rollback that silently drops columns
holding operational history.

## Where the guarantees live

| Guarantee | Mechanism |
| --- | --- |
| A member's roles belong to their own organization | trigger `member_role_organization_check` |
| Global permissions never on organization roles | trigger `role_permission_scope_check` |
| Organization lead requires an active membership | trigger `organization_lead_membership_check` |
| A role cannot be archived while assigned | trigger `role_archive_unassigned_check` |
| An organization cannot be archived with active members | trigger `organization_archive_empty_check` |
| `audit_log`, `incident_log`, `member_status_history` are append-only | trigger `refuse_mutation` + revoked privileges |
| A member is in at most one active unit | partial unique index |
| Callsigns unique among *active* members only | partial unique index |
| Plates unique among *live* vehicles only | partial unique index |
| Exactly one default role per organization | partial unique index |
| Hierarchy 1–100, priority 1–5 | CHECK |
| Archived rows carry actor and reason | CHECK |
| No cascade into operational history | `ON DELETE RESTRICT` |

Each row above has a test in `test/` that proves it, run against a real
PostgreSQL instance rather than a mock — these properties exist only in the
database, so a mocked test would assert nothing about them.

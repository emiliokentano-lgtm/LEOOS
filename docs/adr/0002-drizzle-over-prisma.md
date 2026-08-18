# ADR-0002 — Drizzle ORM rather than Prisma

**Status:** Accepted · 2026-08-18

## Context

The requirements state "use database constraints where appropriate", and the data
model depends on them heavily: partial unique indexes (one active unit membership
per member, callsigns unique among active members only, one default role per
organization), CHECK constraints, triggers preventing cross-organization role
assignment, and `SELECT … FOR UPDATE` row locking in the authorization kernel.

Prisma's schema language does not express partial unique indexes, CHECK
constraints, or triggers. Using it means maintaining those in hand-written SQL
migrations alongside a `schema.prisma` that does not know they exist — so
`prisma migrate` can generate migrations that silently conflict with them. Prisma
also has no first-class row-locking API; `FOR UPDATE` requires `$queryRaw`, which
returns untyped rows, in exactly the code path where type safety matters most.

## Decision

Drizzle ORM with SQL migrations.

## Consequences

**Positive.** Constraints, partial indexes, and triggers live in the same schema
definition as the tables. `.for('update')` is a typed, first-class query builder
method. Generated SQL is predictable, which matters for the queries that resolve
effective permissions. No separate query engine binary, and no generate step in
the build.

**Negative.** Less mature ecosystem than Prisma. No equivalent of Prisma Studio
(mitigated by adminer in the compose stack). Relational queries are more verbose,
and complex joins require more explicit code. Fewer developers have used it.

**Accepted trade-off.** The verbosity cost is paid in ordinary CRUD, which is
low-risk. The benefit is paid out in the authorization kernel, which is where this
project's correctness actually lives.

## Alternatives considered

*Prisma* — better developer experience for straightforward CRUD, worse for
everything this system's guarantees depend on.

*Raw SQL with a query builder like Kysely* — very close to Drizzle in spirit;
Drizzle wins on schema-as-code and migration generation.

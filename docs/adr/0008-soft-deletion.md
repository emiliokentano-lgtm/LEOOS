# ADR-0008 — Soft deletion for operational records

**Status:** Accepted · 2026-08-18
**Context:** raised by project engineering rules 24 and 25.

## Context

The original data model treated `persons.delete`, `vehicles.delete`, and
`roles.delete` as ordinary removals. Engineering rules 24 and 25 require that
historical personnel information and important operational records are preserved
rather than hard-deleted.

The rules are right, and the reason is stronger than policy. This system's records
are referenced by other records that must remain readable indefinitely: an
incident log naming a since-terminated officer, a criminal charge against a person
whose record someone archived, an audit row referencing a role that no longer
exists. A hard `DELETE` either fails on a foreign key or — worse, with
`ON DELETE CASCADE` — silently destroys the incident history along with it.

There is also a regulatory dimension. Operational records of law-enforcement
activity are exactly the kind of data that must be reconstructible after the fact.
A system that can quietly erase them cannot be audited.

## Decision

Records are classified into four deletion behaviours (data model §3a):

| Class | Behaviour |
| --- | --- |
| Never deleted | `audit_log`, `incident_log`, `duty_status_history`, `panic_event` |
| Soft deleted | `person`, `vehicle`, `role`, `organization`, `incident`, `unit`, `map_marker`, `statute`, `incident_type` |
| Deactivated | `user_account`, `organization_member` — status transition, row kept forever |
| Hard deleted | `session`, `auth_token`, `position_history` past retention |

Soft-deletable tables carry `deleted_at`, `deleted_by`, and a required
`deletion_reason`. The existing `.delete` permissions archive; new `.restore`
permissions reverse it; and irreversible erasure moves to a separate global
`admin.purge` permission.

## Consequences

**Positive.** History stays intact and referential integrity holds without
cascades. Archiving is reversible, so an operator mistake is a one-click recovery
rather than a restore-from-backup. `deleted_by` and `deletion_reason` mean the
audit trail explains *why*, not just *what*. Permanent erasure becomes a
deliberate, separately-permissioned, separately-audited act rather than a
side effect of a routine button.

**Negative, and each needs handling rather than acceptance:**

1. *Unique constraints must become partial.* Without
   `U (plate) WHERE deleted_at IS NULL`, archiving a vehicle permanently burns its
   plate. This is the single most common bug in soft-delete implementations.
2. *Every read must filter.* A missed `deleted_at IS NULL` shows archived records
   as live. Mitigated by making the repository helper filter by default and
   requiring an explicit `withDeleted: true` to opt out.
3. *Tables grow monotonically.* Acceptable at this scale — a roleplay server's
   person and vehicle counts are in the tens of thousands, not millions.
4. *Restoration can conflict.* A plate may have been reissued while archived.
   Restore re-validates constraints and returns a specific conflict error.
5. *Archiving a role or organization must be blocked while it is in use*, or
   members are silently left without authority. Enforced by trigger, and the API
   returns the blocking assignments so they can be reassigned first.

**Rejected alternative: a separate archive/history table per entity.** It keeps
live tables small, but every cross-table reference then has to check two places,
and restoring means re-inserting with a new identity — which breaks the very
references the policy exists to protect.

**Rejected alternative: rely on audit-log diffs to reconstruct deleted records.**
The audit log records the change, not a queryable entity. Rebuilding a person from
diffs is forensics, not a feature.

## Note on erasure requests

`admin.purge` exists because a genuine legal erasure obligation can arise, and the
architecture should not make compliance impossible. It is deliberately global,
high-risk, and audited: purging is a documented administrative procedure, not an
ordinary operation. The audit entry recording the purge is itself never deleted.

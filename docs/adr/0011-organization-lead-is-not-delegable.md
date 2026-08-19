# ADR-0011 — Organization Lead is a capability, and it is not delegable

**Status:** Accepted · 2026-08-19

## Context

"Organization Lead" needed a home in the data model. Three options existed:

1. **A permission** (`organization.lead`) attached to a role. Fits the existing
   machinery, and an organization could then manage it themselves.
2. **A flag on the membership row.** Simple, one column.
3. **Its own table**, keyed on (user, organization), grantable only by a global
   administrator.

Option 1 fails on a specific attack. A lead with `roles.edit` could add
`organization.lead` to a role and assign it — the capability would be
self-propagating, and "the global administrator decides who leads an
organization" would stop being true after the first grant. The hierarchy rules
(H3, H4) constrain *which* permissions a role may receive, but a lead is
unbounded within their organization, so H4's subset rule would permit it.

Option 2 avoids that but loses the grant history: who appointed this person, when,
and why. For the single most privileged act inside an organization, that history
is the point.

## Decision

Option 3. `organization_lead(user_id, organization_id, granted_by, granted_at,
revoked_at, revoked_by)`, and both grant and revoke are reserved to global
administrators — `canManageOrganizationLead` returns true only for
`global_admin` or the `org_admin` global capability.

## Consequences

**Positive.** The capability cannot be reached by editing roles, because it is not
a role or a permission. A lead is level ∞ inside their own organization and holds
nothing anywhere else — the grant is a row keyed on an organization, and there is
no global variant of it to obtain. The table carries its own audit trail
independently of `audit_log`.

**Negative, and deliberate.** A global administrator is in the loop for every
leadership change, including routine ones. An organization cannot hand over its
own leadership without one. That is friction, and it is the point: the
alternative is a capability that propagates itself.

**Also.** Granting requires an ACTIVE membership in that organization, enforced
both in the service and by the database trigger
`organization_lead_membership_check`. A lead who is not a member would have
authority over an organization they do not belong to, which no screen would
render correctly and no roster would explain.

**Revocation ends sessions.** Removing this much authority while leaving the
person's open tabs running on a cached view of it would leave a window where the
capability is gone on paper and still effective in practice.

## Note on where scope is enforced

The organization an operation applies to always comes from the URL path, never
from a request body. Early on, the actor context was loaded *for the target
organization*, which made the scope check `actor.organizationId !== targetId`
compare a value to itself — always true, never refusing. `toActorContext` now
returns the organization the actor actually belongs to, or null, so the check has
something real to compare. The tests that caught this assert the refusal reason
is `CROSS_ORGANIZATION`, not merely that the request failed: a scope failure and
a permission failure are different bugs, and a test that accepts either would not
have noticed.

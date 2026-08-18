# ADR-0007 — Integer rank levels rather than a role tree

**Status:** Accepted · 2026-08-18

## Context

The hierarchy rule — never manage anyone at or above your own rank — needs a
comparison between two members' authority. Two shapes are available:

1. **A tree**, where each role has a parent and authority is defined by ancestry.
2. **An integer level per role**, where authority is a numeric comparison.

A tree models "who reports to whom" more richly. But the rule we must enforce is
an *ordering* question, and trees answer ordering badly: two siblings in different
branches have no defined relationship, so a Patrol Sergeant and a Detective
Sergeant would be mutually unmanageable — or manageable — depending on an
arbitrary tie-break we would have to invent anyway. Ancestry checks are also
recursive queries inside a hot authorization path.

Real rank structures are also *described* numerically. Everyone involved already
thinks in terms of "above" and "below".

## Decision

`role.hierarchy_level`, an integer from 1 to 100. A member's effective level is
the **maximum** across their assigned roles. Comparison is strictly greater-than.

Seeded structures leave gaps (10, 20, 30, …) so ranks can be inserted later
without renumbering existing roles.

## Consequences

**Positive.** Comparison is a single integer test — trivial to reason about,
trivial to test exhaustively, and cheap inside a locked transaction. Any two roles
have a defined relationship. Organizations can define whatever structure they like
without a schema change. Equal levels mean mutual immunity, which is the correct
and intuitive reading of "higher than or equal to".

**Negative.** The model cannot express "manages this branch but not that one"
within a single organization. A Detective Lieutenant and a Patrol Lieutenant at
level 60 cannot manage each other even though a real org chart might say otherwise.

**Mitigation.** Where genuine branch separation is needed, it is expressed through
*permissions* — a division-specific permission grants management capability over a
scope — rather than by complicating the ordering. If that proves insufficient in
practice, adding an optional `division` scope to memberships is a smaller change
than replacing the ordering model.

**Why maximum and not sum.** Summing would let two junior roles manufacture senior
authority. Taking the maximum means adding a role can never reduce authority and
never fabricate it.

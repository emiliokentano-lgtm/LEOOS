import { can, type ActorContext } from '@leoos/authz-core';

/**
 * What global search is allowed to look at, for one caller.
 *
 * THIS IS THE SECURITY BOUNDARY OF THE WHOLE FEATURE. Cross-entity search is
 * the one screen that touches every table at once, which makes it the easiest
 * place in the system to leak something: a category nobody remembered to filter
 * turns the search box into a way to enumerate records the operator could not
 * open directly.
 *
 * So the scope is computed ONCE, here, from the actor — and every category
 * query takes it as an argument rather than deciding for itself. A category
 * that cannot express its restriction in terms of this object is a category
 * that has not been thought through.
 *
 * Two rules the categories must all honour:
 *
 *   1. A category the caller may not read is NOT QUERIED. Not queried and
 *      filtered, not returned empty — absent. An empty result set still says
 *      "this category exists and you matched nothing", which is a different
 *      statement from "you cannot search this".
 *
 *   2. COUNTS ARE FILTERED TOO. "MD personnel: 42" leaks the size of another
 *      organization's roster just as surely as listing them would. Every total
 *      is computed over exactly the rows the caller could have opened.
 */

export type SearchCategory =
  | 'persons' | 'vehicles' | 'personnel' | 'organizations' | 'units' | 'incidents';

export const SEARCH_CATEGORIES: readonly SearchCategory[] = [
  'persons', 'vehicles', 'personnel', 'organizations', 'units', 'incidents',
];

export interface SearchScope {
  /** Categories this caller may search at all. */
  categories: Set<SearchCategory>;
  /**
   * Organizations whose org-scoped records the caller may see. `null` means
   * UNRESTRICTED — a global administrator or an org_admin. An empty array means
   * the caller belongs to nothing and may see no org-scoped record at all.
   */
  organizationIds: string[] | null;
  /** Soft-deleted persons and vehicles are separate permissions. */
  includeArchivedPersons: boolean;
  includeArchivedVehicles: boolean;
  actorUserId: string;
  actorOrganizationId: string | null;
}

export function resolveSearchScope(
  actor: ActorContext,
  actorUserId: string,
): SearchScope {
  const categories = new Set<SearchCategory>();

  // Each category is gated by the SAME permission that gates its own screen.
  // Search must never be a second, weaker door into the same data.
  if (can(actor, 'persons.view')) categories.add('persons');
  if (can(actor, 'vehicles.view')) categories.add('vehicles');
  if (can(actor, 'personnel.view')) categories.add('personnel');
  if (can(actor, 'organization.view')) categories.add('organizations');
  if (can(actor, 'dispatch.view')) {
    categories.add('units');
    categories.add('incidents');
  }

  /**
   * Organization reach.
   *
   * A global admin, or anyone holding the `org_admin` capability, is
   * unrestricted. Everyone else sees exactly the organization they are acting
   * as — not every organization they have ever belonged to, because the header
   * that selects the active organization is already validated against their
   * memberships and acting as PD should not surface MD's units.
   */
  const unrestricted = actor.isGlobalAdmin || actor.globalCapabilities.has('org_admin');
  const organizationIds = unrestricted
    ? null
    : actor.organizationId === null ? [] : [actor.organizationId];

  return {
    categories,
    organizationIds,
    includeArchivedPersons: can(actor, 'persons.view_deleted'),
    includeArchivedVehicles: can(actor, 'vehicles.view_deleted'),
    actorUserId,
    actorOrganizationId: actor.organizationId,
  };
}

/** Minimum characters before anything is queried at all. */
export const MIN_SEARCH_LENGTH = 2;

/**
 * Per-category cap in a grouped search, and the hard ceiling on a paged one.
 *
 * A grouped search runs six queries at once, so each is kept small: the operator
 * is scanning for the right category, not reading a category. Opening one
 * category then pages properly.
 */
export const GROUPED_LIMIT = 5;
export const MAX_CATEGORY_LIMIT = 50;

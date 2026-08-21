import type { GlobalCapabilityKey, PermissionKey } from '@leoos/contracts';

/**
 * Navigation definition.
 *
 * Each item declares what it requires. The sidebar is filtered on the SERVER, so
 * items a user cannot access are never rendered and their existence is not
 * disclosed in the HTML payload.
 *
 * TWO KINDS OF REQUIREMENT, because there are two kinds of authority.
 * `permission` is organization-scoped and comes from the active membership's
 * roles. `capabilities` is global and comes from `user_global_role` — an
 * account administrator holds `user_admin` and no organization permission at
 * all, so gating the administration area on a permission key alone would hide
 * it from exactly the people it exists for.
 *
 * An item with both is shown when EITHER matches: they are alternative routes to
 * the same screen, not conditions to be satisfied together.
 */

export interface NavItem {
  href: string;
  label: string;
  /** lucide-react icon name. */
  icon: string;
  /** null = always visible to an authenticated user. */
  permission: PermissionKey | null;
  /** Any one of these global capabilities also reveals the item. */
  capabilities?: GlobalCapabilityKey[];
  shortcut?: string;
  description?: string;
}

export interface NavSection {
  id: string;
  label: string | null;
  items: NavItem[];
}

export const NAVIGATION: NavSection[] = [
  {
    id: 'operations',
    label: null, // primary items carry no section heading
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: 'LayoutDashboard', permission: null, shortcut: 'G D' },
      { href: '/search', label: 'Search', icon: 'Search', permission: null, shortcut: 'G S' },
      { href: '/map', label: 'Map', icon: 'Map', permission: 'map.view', shortcut: 'G M' },
      { href: '/dispatch', label: 'Dispatch', icon: 'Radio', permission: 'dispatch.view', shortcut: 'G L' },
    ],
  },
  {
    id: 'records',
    label: 'Records',
    items: [
      { href: '/persons', label: 'Persons', icon: 'Users', permission: 'persons.view' },
      { href: '/vehicles', label: 'Vehicles', icon: 'Car', permission: 'vehicles.view' },
    ],
  },
  {
    id: 'organization',
    label: 'Organization',
    items: [
      { href: '/personnel', label: 'Personnel', icon: 'IdCard', permission: 'personnel.view' },
      { href: '/roles', label: 'Roles', icon: 'Shield', permission: 'roles.view' },
      { href: '/organization', label: 'Organization', icon: 'Building2', permission: 'organization.view' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      {
        href: '/admin', label: 'Administration', icon: 'Settings', permission: 'admin.users',
        capabilities: ['global_admin', 'user_admin', 'org_admin', 'audit_viewer', 'support'],
      },
      {
        href: '/admin/users', label: 'User accounts', icon: 'Users', permission: 'admin.users',
        capabilities: ['global_admin', 'user_admin', 'support'],
      },
      {
        href: '/admin/organizations', label: 'Organizations', icon: 'Building2',
        permission: 'admin.organizations', capabilities: ['global_admin', 'org_admin'],
      },
      {
        href: '/admin/leads', label: 'Organization Leads', icon: 'ShieldCheck',
        permission: 'admin.org_leads', capabilities: ['global_admin', 'org_admin'],
      },
      {
        // Capability-only. Gating this on `roles.view` would put it in the
        // sidebar of every officer who can read their own organization's
        // roles, and the guard behind it would bounce them straight back.
        href: '/admin/permissions', label: 'Permissions', icon: 'ShieldAlert',
        permission: null,
        capabilities: ['global_admin', 'org_admin', 'audit_viewer'],
      },
      {
        href: '/audit', label: 'Audit Logs', icon: 'ScrollText', permission: 'admin.audit_logs',
        capabilities: ['global_admin', 'audit_viewer'],
      },
      {
        href: '/admin/system', label: 'System', icon: 'Server', permission: null,
        capabilities: ['global_admin'],
      },
    ],
  },
];

/** Page titles and breadcrumb trails, keyed by route segment. */
export const PAGE_META: Record<string, { title: string; parent?: string }> = {
  dashboard: { title: 'Dashboard' },
  search: { title: 'Search' },
  map: { title: 'Live Map' },
  dispatch: { title: 'Dispatch' },
  persons: { title: 'Persons', parent: 'Records' },
  vehicles: { title: 'Vehicles', parent: 'Records' },
  personnel: { title: 'Personnel', parent: 'Organization' },
  roles: { title: 'Roles', parent: 'Organization' },
  organization: { title: 'Organization', parent: 'Organization' },
  admin: { title: 'Administration', parent: 'System' },
  users: { title: 'User accounts', parent: 'Administration' },
  leads: { title: 'Organization Leads', parent: 'Administration' },
  permissions: { title: 'Permissions', parent: 'Administration' },
  system: { title: 'System', parent: 'Administration' },
  audit: { title: 'Audit Logs', parent: 'System' },
  design: { title: 'Design System', parent: 'System' },
};

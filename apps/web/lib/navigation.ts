import type { PermissionKey } from '@leoos/contracts';

/**
 * Navigation definition.
 *
 * Each item declares the permission it requires. The sidebar is filtered on the
 * SERVER, so items a user cannot access are never rendered and their existence is
 * not disclosed in the HTML payload.
 */

export interface NavItem {
  href: string;
  label: string;
  /** lucide-react icon name. */
  icon: string;
  /** null = always visible to an authenticated user. */
  permission: PermissionKey | null;
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
      { href: '/admin', label: 'Administration', icon: 'Settings', permission: 'admin.users' },
      { href: '/admin/organizations', label: 'Organizations', icon: 'Building2', permission: 'admin.organizations' },
      { href: '/audit', label: 'Audit Logs', icon: 'ScrollText', permission: 'admin.audit_logs' },
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
  audit: { title: 'Audit Logs', parent: 'System' },
  design: { title: 'Design System', parent: 'System' },
};

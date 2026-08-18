import type { PermissionKey } from '@leoos/contracts';
import { MOCK_ORGANIZATIONS } from './organizations';

/**
 * MOCK session. NOT a real authentication result — see ./README.md.
 *
 * IMPORTANT: this shape mirrors what the API will return, but the UI treats
 * permissions as COSMETIC ONLY. They decide what to render; they never decide
 * what is allowed. Server-side authorization is the only enforcement point
 * (engineering rules 9, 10). No screen in this phase performs a mutation.
 */

export interface MockSession {
  userId: string;
  username: string;
  displayName: string;
  email: string;
  /** Active organization context. */
  organizationId: string;
  /** Organizations the user is a member of — drives the org switcher. */
  organizationIds: string[];
  roleName: string;
  /** Effective hierarchy level in the active organization. Rendered for context;
   *  never used for a client-side authorization decision. */
  hierarchyLevel: number;
  callsign: string;
  badgeNumber: string;
  permissions: PermissionKey[];
  isGlobalAdmin: boolean;
  isOrgLead: boolean;
}

export const MOCK_SESSION: MockSession = {
  userId: 'usr-0001',
  username: 'j.mercer',
  displayName: 'Jordan Mercer',
  email: 'j.mercer@lspd.gov.example',
  organizationId: 'org-pd',
  organizationIds: ['org-pd', 'org-fib'],
  roleName: 'Lieutenant',
  hierarchyLevel: 60,
  callsign: '3-ADAM-12',
  badgeNumber: '4471',
  isGlobalAdmin: false,
  isOrgLead: false,
  permissions: [
    'map.view', 'map.track_units', 'map.markers.manage',
    'dispatch.view', 'dispatch.create', 'dispatch.manage', 'dispatch.assign',
    'dispatch.close', 'dispatch.panic', 'dispatch.panic.acknowledge', 'units.manage',
    'persons.view', 'persons.create', 'persons.edit', 'persons.flags.manage',
    'persons.criminal.view', 'persons.warrants.manage',
    'vehicles.view', 'vehicles.create', 'vehicles.edit', 'vehicles.flags.manage',
    'personnel.view', 'personnel.edit', 'personnel.promote', 'personnel.callsign',
    'roles.view',
    'organization.view',
    'admin.audit_logs',
  ],
};

export const MOCK_USER_ORGANIZATIONS = MOCK_ORGANIZATIONS.filter((o) =>
  MOCK_SESSION.organizationIds.includes(o.id),
);

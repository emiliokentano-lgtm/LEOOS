import type { OrganizationSummary } from '@leoos/contracts';

/**
 * MOCK organizations. NOT production data — see ./README.md.
 *
 * Note the shape: these look exactly like rows from the `organization` table,
 * including the per-organization colour. No organization key appears anywhere in
 * component logic — the UI only ever reads these fields (engineering rules 5, 8).
 */
export const MOCK_ORGANIZATIONS: OrganizationSummary[] = [
  { id: 'org-pd', key: 'PD', name: 'Los Santos Police Department', shortName: 'LSPD', category: 'law_enforcement', color: '#3b82d9' },
  { id: 'org-md', key: 'MD', name: 'Los Santos Medical Department', shortName: 'LSMD', category: 'medical', color: '#2ea86b' },
  { id: 'org-fib', key: 'FIB', name: 'Federal Investigation Bureau', shortName: 'FIB', category: 'federal', color: '#8b5cf6' },
  { id: 'org-army', key: 'ARMY', name: 'National Guard', shortName: 'ARMY', category: 'military', color: '#a3a635' },
  { id: 'org-ice', key: 'ICE', name: 'Immigration and Customs Enforcement', shortName: 'ICE', category: 'federal', color: '#14b8a6' },
  { id: 'org-mech', key: 'MECHANIC', name: 'Los Santos Customs', shortName: 'LSC', category: 'civil_service', color: '#d99a2b' },
];

export function mockOrg(id: string): OrganizationSummary {
  const org = MOCK_ORGANIZATIONS.find((o) => o.id === id);
  if (!org) throw new Error(`Unknown mock organization: ${id}`);
  return org;
}

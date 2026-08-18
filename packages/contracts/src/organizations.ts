/**
 * Organization *categories* — not the organizations themselves.
 *
 * Organizations are database rows (engineering rules 5, 8). This file only
 * declares the category vocabulary, which exists so that cross-organization
 * behaviour can be expressed as data ("medical-category organizations may view
 * medical records") rather than as `if (org.key === 'MD')`.
 *
 * There is deliberately no list of PD/MD/FIB/ARMY/ICE/MECHANIC in the codebase.
 */

export type OrganizationCategory =
  | 'law_enforcement'
  | 'medical'
  | 'federal'
  | 'military'
  | 'civil_service'
  | 'other';

export const ORGANIZATION_CATEGORIES: Record<OrganizationCategory, { label: string; icon: string }> = {
  law_enforcement: { label: 'Law Enforcement', icon: 'Shield' },
  medical: { label: 'Medical', icon: 'HeartPulse' },
  federal: { label: 'Federal', icon: 'Landmark' },
  military: { label: 'Military', icon: 'Swords' },
  civil_service: { label: 'Civil Service', icon: 'Wrench' },
  other: { label: 'Other', icon: 'Building2' },
};

/** Shape the UI needs to render an organization. Mirrors the `organization`
 *  table's public columns — never its internal ones. */
export interface OrganizationSummary {
  id: string;
  key: string;
  name: string;
  shortName: string;
  category: OrganizationCategory;
  /** Hex colour, stored per-organization in the database so that adding an
   *  organization never requires a stylesheet edit. */
  color: string;
}

import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { incidentType } from '../schema/index.js';

/**
 * Default incident-type catalogue, shared by every organization
 * (`organization_id = NULL`). Organizations add their own through the
 * application; these are starting points, not a fixed list.
 */
const TYPES = [
  { key: 'armed_robbery', label: 'Armed Robbery', category: 'crime', defaultPriority: 1, icon: 'Siren' },
  { key: 'shots_fired', label: 'Shots Fired', category: 'crime', defaultPriority: 1, icon: 'Crosshair' },
  { key: 'pursuit', label: 'Pursuit', category: 'crime', defaultPriority: 1, icon: 'Car' },
  { key: 'officer_down', label: 'Officer Down', category: 'emergency', defaultPriority: 1, icon: 'TriangleAlert' },
  { key: 'medical_emergency', label: 'Medical Emergency', category: 'medical', defaultPriority: 1, icon: 'HeartPulse' },
  { key: 'structure_fire', label: 'Structure Fire', category: 'fire', defaultPriority: 1, icon: 'Flame' },
  { key: 'assault', label: 'Assault', category: 'crime', defaultPriority: 2, icon: 'ShieldAlert' },
  { key: 'burglary', label: 'Burglary', category: 'crime', defaultPriority: 2, icon: 'DoorOpen' },
  { key: 'traffic_collision', label: 'Traffic Collision', category: 'traffic', defaultPriority: 2, icon: 'CarFront' },
  { key: 'domestic_disturbance', label: 'Domestic Disturbance', category: 'crime', defaultPriority: 2, icon: 'Home' },
  { key: 'theft', label: 'Theft', category: 'crime', defaultPriority: 3, icon: 'Package' },
  { key: 'vandalism', label: 'Vandalism', category: 'crime', defaultPriority: 3, icon: 'Hammer' },
  { key: 'suspicious_activity', label: 'Suspicious Activity', category: 'crime', defaultPriority: 3, icon: 'Eye' },
  { key: 'traffic_stop', label: 'Traffic Stop', category: 'traffic', defaultPriority: 3, icon: 'OctagonAlert' },
  { key: 'welfare_check', label: 'Welfare Check', category: 'service', defaultPriority: 3, icon: 'UserCheck' },
  { key: 'surveillance', label: 'Surveillance', category: 'investigation', defaultPriority: 3, icon: 'Binoculars' },
  { key: 'transport', label: 'Prisoner Transport', category: 'service', defaultPriority: 4, icon: 'Truck' },
  { key: 'noise_complaint', label: 'Noise Complaint', category: 'service', defaultPriority: 4, icon: 'Volume2' },
  { key: 'vehicle_recovery', label: 'Vehicle Recovery', category: 'service', defaultPriority: 5, icon: 'Wrench' },
  { key: 'administrative', label: 'Administrative', category: 'service', defaultPriority: 5, icon: 'FileText' },
] as const;

export async function seedIncidentTypes(db: Database): Promise<number> {
  await db
    .insert(incidentType)
    .values(TYPES.map((t) => ({ ...t, organizationId: null })))
    .onConflictDoUpdate({
      target: incidentType.key,
      set: {
        label: sql`excluded.label`,
        category: sql`excluded.category`,
        defaultPriority: sql`excluded.default_priority`,
        icon: sql`excluded.icon`,
      },
    });
  return TYPES.length;
}

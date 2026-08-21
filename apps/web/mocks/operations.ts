import type { DutyStatusKey, IncidentPriority, IncidentStatusKey, UnitTypeKey } from '@leoos/contracts';

/** MOCK operational data. NOT production data — see ./README.md. */

// Fixed base time so server and client render identically (no hydration drift).
export const MOCK_NOW = new Date('2026-08-18T21:14:00Z');

function minutesAgo(m: number): Date {
  return new Date(MOCK_NOW.getTime() - m * 60_000);
}

export interface MockIncident {
  id: string;
  number: string;
  organizationId: string;
  type: string;
  priority: IncidentPriority;
  status: IncidentStatusKey;
  title: string;
  locationText: string;
  x: number;
  y: number;
  assignedUnitIds: string[];
  createdAt: Date;
  callerName?: string;
}

export const MOCK_INCIDENTS: MockIncident[] = [
  { id: 'inc-1', number: '2026-08-000431', organizationId: 'org-pd', type: 'Armed Robbery', priority: 1, status: 'dispatched', title: 'Armed robbery in progress — Fleeca Bank', locationText: 'Legion Square, Alta St', x: 149, y: -1040, assignedUnitIds: ['unit-1', 'unit-3'], createdAt: minutesAgo(4), callerName: 'M. Alvarez' },
  { id: 'inc-2', number: '2026-08-000430', organizationId: 'org-md', type: 'Medical Emergency', priority: 1, status: 'on_scene', title: 'Cardiac arrest — male, approx. 60', locationText: 'Vinewood Blvd 4471', x: 296, y: 180, assignedUnitIds: ['unit-5'], createdAt: minutesAgo(11), callerName: 'Unknown' },
  { id: 'inc-3', number: '2026-08-000429', organizationId: 'org-pd', type: 'Traffic Collision', priority: 2, status: 'on_scene', title: 'Two-vehicle collision, injuries reported', locationText: 'Olympic Fwy / Innocence Blvd', x: -680, y: -854, assignedUnitIds: ['unit-2', 'unit-5'], createdAt: minutesAgo(23) },
  { id: 'inc-4', number: '2026-08-000428', organizationId: 'org-pd', type: 'Pursuit', priority: 1, status: 'dispatched', title: 'Vehicle pursuit — grey Sultan, plate 44XKM921', locationText: 'Route 68 westbound', x: -1420, y: 2100, assignedUnitIds: ['unit-4'], createdAt: minutesAgo(2) },
  { id: 'inc-5', number: '2026-08-000427', organizationId: 'org-fib', type: 'Surveillance', priority: 3, status: 'pending', title: 'Requested observation — warehouse district', locationText: 'Elysian Island, Sub Dock', x: 180, y: -2740, assignedUnitIds: [], createdAt: minutesAgo(38) },
  { id: 'inc-6', number: '2026-08-000426', organizationId: 'org-pd', type: 'Noise Complaint', priority: 4, status: 'pending', title: 'Repeated noise complaint — residential', locationText: 'Grove St 14', x: 88, y: -1930, assignedUnitIds: [], createdAt: minutesAgo(52) },
  { id: 'inc-7', number: '2026-08-000425', organizationId: 'org-mech', type: 'Vehicle Recovery', priority: 5, status: 'on_hold', title: 'Recovery request — abandoned vehicle', locationText: 'Senora Fwy, mile 12', x: 2400, y: 3800, assignedUnitIds: ['unit-7'], createdAt: minutesAgo(94) },
  { id: 'inc-8', number: '2026-08-000424', organizationId: 'org-pd', type: 'Burglary', priority: 3, status: 'closed', title: 'Residential burglary — forced entry', locationText: 'Mirror Park, Nikola Ave', x: 1180, y: -680, assignedUnitIds: ['unit-2'], createdAt: minutesAgo(140) },
];

export interface MockUnit {
  id: string;
  callsign: string;
  organizationId: string;
  unitType: UnitTypeKey;
  status: DutyStatusKey;
  memberNames: string[];
  vehicle?: string;
  vehiclePlate?: string;
  x: number;
  y: number;
  heading: number;
  incidentId?: string;
  lastUpdate: Date;
}

export const MOCK_UNITS: MockUnit[] = [
  { id: 'unit-1', callsign: '3-ADAM-12', organizationId: 'org-pd', unitType: 'patrol', status: 'on_scene', memberNames: ['Jordan Mercer', 'Alex Reyes'], vehicle: 'Police Cruiser', vehiclePlate: 'LSPD0412', x: 149, y: -1040, heading: 87, incidentId: 'inc-1', lastUpdate: minutesAgo(0.1) },
  { id: 'unit-2', callsign: '2-LINCOLN-4', organizationId: 'org-pd', unitType: 'patrol', status: 'available', memberNames: ['Dana Whitfield'], vehicle: 'Police Interceptor', vehiclePlate: 'LSPD0219', x: -680, y: -854, heading: 214, lastUpdate: minutesAgo(0.2) },
  { id: 'unit-3', callsign: '1-SAM-7', organizationId: 'org-pd', unitType: 'supervisor', status: 'in_operation', memberNames: ['Marcus Boone'], vehicle: 'Unmarked Sedan', vehiclePlate: 'LSPD0107', x: 210, y: -980, heading: 12, incidentId: 'inc-1', lastUpdate: minutesAgo(0.3) },
  { id: 'unit-4', callsign: 'AIR-1', organizationId: 'org-pd', unitType: 'air', status: 'in_operation', memberNames: ['Priya Raman', 'Tom Vasquez'], vehicle: 'Maverick', vehiclePlate: 'LSPDAIR1', x: -1420, y: 2100, heading: 268, incidentId: 'inc-4', lastUpdate: minutesAgo(0.1) },
  { id: 'unit-5', callsign: 'MED-3', organizationId: 'org-md', unitType: 'ems', status: 'transporting', memberNames: ['Sam Okafor', 'Nina Halvorsen'], vehicle: 'Ambulance', vehiclePlate: 'LSMD0031', x: 296, y: 180, heading: 145, incidentId: 'inc-2', lastUpdate: minutesAgo(0.2) },
  { id: 'unit-6', callsign: 'MED-1', organizationId: 'org-md', unitType: 'ems', status: 'at_hq', memberNames: ['Eli Fontaine'], vehicle: 'Ambulance', vehiclePlate: 'LSMD0011', x: 340, y: -580, heading: 0, lastUpdate: minutesAgo(1.4) },
  { id: 'unit-7', callsign: 'TOW-2', organizationId: 'org-mech', unitType: 'transport', status: 'busy', memberNames: ['Ray Kovac'], vehicle: 'Flatbed', vehiclePlate: 'LSC00202', x: 2400, y: 3800, heading: 300, incidentId: 'inc-7', lastUpdate: minutesAgo(0.8) },
  { id: 'unit-8', callsign: 'FIB-2', organizationId: 'org-fib', unitType: 'investigation', status: 'busy', memberNames: ['Claire Nakamura'], vehicle: 'Unmarked SUV', vehiclePlate: 'FIB00021', x: 180, y: -2740, heading: 45, lastUpdate: minutesAgo(0.5) },
  { id: 'unit-9', callsign: '4-KING-9', organizationId: 'org-pd', unitType: 'k9', status: 'available', memberNames: ['Owen Bright'], vehicle: 'K9 Transport', vehiclePlate: 'LSPD0409', x: 820, y: -1200, heading: 190, lastUpdate: minutesAgo(0.4) },
  { id: 'unit-10', callsign: 'ICE-1', organizationId: 'org-ice', unitType: 'patrol', status: 'off_duty', memberNames: ['Hana Petrov'], x: 0, y: 0, heading: 0, lastUpdate: minutesAgo(46) },
];

export interface MockActivity {
  id: string;
  at: Date;
  actor: string;
  action: string;
  target: string;
  tone: 'default' | 'warning' | 'danger';
}

export const MOCK_ACTIVITY: MockActivity[] = [
  { id: 'a1', at: minutesAgo(1), actor: 'Marcus Boone', action: 'assigned', target: '1-SAM-7 to #2026-08-000431', tone: 'default' },
  { id: 'a2', at: minutesAgo(2), actor: 'System', action: 'created incident', target: '#2026-08-000428 — Pursuit', tone: 'danger' },
  { id: 'a3', at: minutesAgo(6), actor: 'Dana Whitfield', action: 'status changed', target: 'Busy → Available', tone: 'default' },
  { id: 'a4', at: minutesAgo(9), actor: 'Sam Okafor', action: 'arrived on scene', target: '#2026-08-000430', tone: 'default' },
  { id: 'a5', at: minutesAgo(14), actor: 'Jordan Mercer', action: 'flagged person', target: 'D. Castellanos — armed & dangerous', tone: 'warning' },
  { id: 'a6', at: minutesAgo(22), actor: 'Priya Raman', action: 'joined unit', target: 'AIR-1', tone: 'default' },
  { id: 'a7', at: minutesAgo(31), actor: 'Marcus Boone', action: 'closed incident', target: '#2026-08-000424 — Burglary', tone: 'default' },
];

export interface MockPerson {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phone: string;
  address: string;
  flags: { type: string; severity: 'info' | 'caution' | 'critical' }[];
  licenses: { type: string; status: 'valid' | 'suspended' | 'revoked' }[];
  hasWarrant: boolean;
}

export const MOCK_PERSONS: MockPerson[] = [
  { id: 'p1', firstName: 'Diego', lastName: 'Castellanos', dateOfBirth: '1991-03-14', phone: '555-0142', address: 'Mirror Park, Nikola Ave 12', flags: [{ type: 'Armed & dangerous', severity: 'critical' }, { type: 'Wanted', severity: 'critical' }], licenses: [{ type: 'Driver', status: 'suspended' }], hasWarrant: true },
  { id: 'p2', firstName: 'Marina', lastName: 'Volkov', dateOfBirth: '1988-11-02', phone: '555-0177', address: 'Vespucci Beach, Bay City Ave 3', flags: [], licenses: [{ type: 'Driver', status: 'valid' }, { type: 'Weapon', status: 'valid' }], hasWarrant: false },
  { id: 'p3', firstName: 'Tobias', lastName: 'Grange', dateOfBirth: '1979-06-27', phone: '555-0198', address: 'Sandy Shores, Alhambra Dr 8', flags: [{ type: 'BOLO', severity: 'caution' }], licenses: [{ type: 'Driver', status: 'valid' }], hasWarrant: false },
  { id: 'p4', firstName: 'Ingrid', lastName: 'Sørensen', dateOfBirth: '1995-01-19', phone: '555-0110', address: 'Rockford Hills, Dorset Dr 44', flags: [], licenses: [{ type: 'Driver', status: 'valid' }, { type: 'Pilot', status: 'valid' }], hasWarrant: false },
  { id: 'p5', firstName: 'Ahmed', lastName: 'Farouk', dateOfBirth: '1983-09-08', phone: '555-0163', address: 'Little Seoul, Fenwell Pl 21', flags: [{ type: 'Mental health', severity: 'info' }], licenses: [{ type: 'Driver', status: 'revoked' }], hasWarrant: false },
  { id: 'p6', firstName: 'Lucia', lastName: 'Barrett', dateOfBirth: '2000-04-30', phone: '555-0125', address: 'Del Perro, Prosperity St 7', flags: [], licenses: [], hasWarrant: false },
];

export interface MockVehicle {
  id: string;
  plate: string;
  model: string;
  displayName: string;
  color: string;
  ownerName: string | null;
  ownerOrganizationId: string | null;
  registration: 'registered' | 'expired' | 'unregistered';
  insurance: 'insured' | 'uninsured' | 'expired';
  flags: string[];
}

export const MOCK_VEHICLES: MockVehicle[] = [
  { id: 'v1', plate: '44XKM921', model: 'sultan', displayName: 'Karin Sultan', color: 'Grey', ownerName: 'Diego Castellanos', ownerOrganizationId: null, registration: 'expired', insurance: 'uninsured', flags: ['Stolen', 'BOLO'] },
  { id: 'v2', plate: 'LSPD0412', model: 'police3', displayName: 'Police Cruiser', color: 'Black/White', ownerName: null, ownerOrganizationId: 'org-pd', registration: 'registered', insurance: 'insured', flags: [] },
  { id: 'v3', plate: '18TRV044', model: 'baller', displayName: 'Gallivanter Baller', color: 'Black', ownerName: 'Marina Volkov', ownerOrganizationId: null, registration: 'registered', insurance: 'insured', flags: [] },
  { id: 'v4', plate: 'LSMD0031', model: 'ambulance', displayName: 'Ambulance', color: 'White', ownerName: null, ownerOrganizationId: 'org-md', registration: 'registered', insurance: 'insured', flags: [] },
  { id: 'v5', plate: '90QQP517', model: 'futo', displayName: 'Karin Futo', color: 'Blue', ownerName: 'Tobias Grange', ownerOrganizationId: null, registration: 'registered', insurance: 'expired', flags: ['Impounded'] },
  { id: 'v6', plate: '31LLM880', model: 'issi3', displayName: 'Weeny Issi', color: 'Yellow', ownerName: 'Lucia Barrett', ownerOrganizationId: null, registration: 'unregistered', insurance: 'uninsured', flags: [] },
];

export interface MockMember {
  id: string;
  name: string;
  callsign: string;
  badgeNumber: string;
  roleName: string;
  hierarchyLevel: number;
  status: DutyStatusKey;
  organizationId: string;
  lastSeen: Date;
}

export const MOCK_MEMBERS: MockMember[] = [
  { id: 'm1', name: 'Marcus Boone', callsign: '1-SAM-7', badgeNumber: '1002', roleName: 'Commander', hierarchyLevel: 80, status: 'in_operation', organizationId: 'org-pd', lastSeen: minutesAgo(0.3) },
  { id: 'm2', name: 'Jordan Mercer', callsign: '3-ADAM-12', badgeNumber: '4471', roleName: 'Lieutenant', hierarchyLevel: 60, status: 'on_scene', organizationId: 'org-pd', lastSeen: minutesAgo(0.1) },
  { id: 'm3', name: 'Dana Whitfield', callsign: '2-LINCOLN-4', badgeNumber: '4482', roleName: 'Sergeant', hierarchyLevel: 50, status: 'available', organizationId: 'org-pd', lastSeen: minutesAgo(0.2) },
  { id: 'm4', name: 'Alex Reyes', callsign: '3-ADAM-12', badgeNumber: '5510', roleName: 'Officer', hierarchyLevel: 30, status: 'on_scene', organizationId: 'org-pd', lastSeen: minutesAgo(0.1) },
  { id: 'm5', name: 'Owen Bright', callsign: '4-KING-9', badgeNumber: '5533', roleName: 'Officer', hierarchyLevel: 30, status: 'available', organizationId: 'org-pd', lastSeen: minutesAgo(0.4) },
  { id: 'm6', name: 'Priya Raman', callsign: 'AIR-1', badgeNumber: '5104', roleName: 'Officer', hierarchyLevel: 30, status: 'in_operation', organizationId: 'org-pd', lastSeen: minutesAgo(0.1) },
  { id: 'm7', name: 'Tom Vasquez', callsign: 'AIR-1', badgeNumber: '6201', roleName: 'Cadet', hierarchyLevel: 10, status: 'in_operation', organizationId: 'org-pd', lastSeen: minutesAgo(0.1) },
  { id: 'm8', name: 'Hana Petrov', callsign: '—', badgeNumber: '6244', roleName: 'Cadet', hierarchyLevel: 10, status: 'off_duty', organizationId: 'org-pd', lastSeen: minutesAgo(320) },
];

export interface MockRole {
  id: string;
  name: string;
  hierarchyLevel: number;
  memberCount: number;
  permissionCount: number;
  isDefault: boolean;
}

export const MOCK_ROLES: MockRole[] = [
  { id: 'r1', name: 'Chief', hierarchyLevel: 100, memberCount: 1, permissionCount: 38, isDefault: false },
  { id: 'r2', name: 'Deputy Chief', hierarchyLevel: 90, memberCount: 2, permissionCount: 35, isDefault: false },
  { id: 'r3', name: 'Commander', hierarchyLevel: 80, memberCount: 3, permissionCount: 30, isDefault: false },
  { id: 'r4', name: 'Lieutenant', hierarchyLevel: 60, memberCount: 6, permissionCount: 24, isDefault: false },
  { id: 'r5', name: 'Sergeant', hierarchyLevel: 50, memberCount: 9, permissionCount: 19, isDefault: false },
  { id: 'r6', name: 'Officer', hierarchyLevel: 30, memberCount: 24, permissionCount: 14, isDefault: false },
  { id: 'r7', name: 'Cadet', hierarchyLevel: 10, memberCount: 7, permissionCount: 8, isDefault: true },
];



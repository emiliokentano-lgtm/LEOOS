/**
 * Operational status catalogues.
 *
 * These are the *seeded defaults*, not a hardcoded ceiling — the database carries
 * a `duty_status_type` table so an organization can extend the list without a code
 * change (engineering rules 5, 6, 7). The UI reads this catalogue so that colour,
 * label, and icon stay consistent everywhere a status appears.
 *
 * Every status carries a label and an icon name in addition to a colour, because
 * colour must never be the only indicator (accessibility; ~8% of men have some
 * colour vision deficiency, and red/green duty status is the classic failure).
 */

export type DutyStatusKey =
  | 'off_duty'
  | 'available'
  | 'busy'
  | 'in_operation'
  | 'on_scene'
  | 'at_hq'
  | 'transporting'
  | 'panic';

export interface DutyStatusMeta {
  readonly key: DutyStatusKey;
  readonly label: string;
  /** Short form for dense table cells and map labels. */
  readonly short: string;
  /** CSS custom property name defined in the token layer. */
  readonly token: string;
  /** lucide-react icon name — the non-colour indicator. */
  readonly icon: string;
  /** Counts toward "units available" figures. */
  readonly isAvailable: boolean;
  /** Member is considered on duty (shows on the map, counts as active). */
  readonly isOnDuty: boolean;
  readonly sortOrder: number;
}

export const DUTY_STATUSES: Record<DutyStatusKey, DutyStatusMeta> = {
  available: {
    key: 'available', label: 'Available', short: 'AVL', token: '--status-available',
    icon: 'CircleCheck', isAvailable: true, isOnDuty: true, sortOrder: 10,
  },
  busy: {
    key: 'busy', label: 'Busy', short: 'BSY', token: '--status-busy',
    icon: 'CircleMinus', isAvailable: false, isOnDuty: true, sortOrder: 20,
  },
  on_scene: {
    key: 'on_scene', label: 'On Scene', short: 'SCN', token: '--status-onscene',
    icon: 'MapPin', isAvailable: false, isOnDuty: true, sortOrder: 30,
  },
  in_operation: {
    key: 'in_operation', label: 'In Operation', short: 'OPS', token: '--status-operation',
    icon: 'Crosshair', isAvailable: false, isOnDuty: true, sortOrder: 40,
  },
  transporting: {
    key: 'transporting', label: 'Transporting', short: 'TRN', token: '--status-transport',
    icon: 'ArrowRightLeft', isAvailable: false, isOnDuty: true, sortOrder: 50,
  },
  at_hq: {
    key: 'at_hq', label: 'At HQ', short: 'HQ', token: '--status-hq',
    icon: 'Building2', isAvailable: true, isOnDuty: true, sortOrder: 60,
  },
  panic: {
    key: 'panic', label: 'Panic', short: 'PANIC', token: '--status-panic',
    icon: 'TriangleAlert', isAvailable: false, isOnDuty: true, sortOrder: 1,
  },
  off_duty: {
    key: 'off_duty', label: 'Off Duty', short: 'OFF', token: '--status-offline',
    icon: 'CircleSlash', isAvailable: false, isOnDuty: false, sortOrder: 90,
  },
};

export const DUTY_STATUS_LIST: DutyStatusMeta[] = Object.values(DUTY_STATUSES).sort(
  (a, b) => a.sortOrder - b.sortOrder,
);

// ── Incidents ──────────────────────────────────────────────────────────────

export type IncidentStatusKey =
  | 'pending' | 'dispatched' | 'on_scene' | 'on_hold' | 'closed' | 'cancelled';

export interface IncidentStatusMeta {
  readonly key: IncidentStatusKey;
  readonly label: string;
  readonly token: string;
  readonly icon: string;
  readonly isOpen: boolean;
}

export const INCIDENT_STATUSES: Record<IncidentStatusKey, IncidentStatusMeta> = {
  pending: { key: 'pending', label: 'Pending', token: '--status-busy', icon: 'Clock', isOpen: true },
  dispatched: { key: 'dispatched', label: 'Dispatched', token: '--status-onscene', icon: 'Send', isOpen: true },
  on_scene: { key: 'on_scene', label: 'On Scene', token: '--status-operation', icon: 'MapPin', isOpen: true },
  on_hold: { key: 'on_hold', label: 'On Hold', token: '--status-hold', icon: 'PauseCircle', isOpen: true },
  closed: { key: 'closed', label: 'Closed', token: '--status-available', icon: 'CircleCheck', isOpen: false },
  cancelled: { key: 'cancelled', label: 'Cancelled', token: '--status-offline', icon: 'CircleSlash', isOpen: false },
};

/** Priority 1 (highest) … 5 (lowest). Numeric so it is orderable and readable. */
export type IncidentPriority = 1 | 2 | 3 | 4 | 5;

export interface PriorityMeta {
  readonly value: IncidentPriority;
  readonly label: string;
  readonly token: string;
  /** Response expectation, shown as a tooltip in the dispatch queue. */
  readonly description: string;
}

export const PRIORITIES: Record<IncidentPriority, PriorityMeta> = {
  1: { value: 1, label: 'P1', token: '--priority-1', description: 'Immediate — life threatening' },
  2: { value: 2, label: 'P2', token: '--priority-2', description: 'Urgent — rapid response' },
  3: { value: 3, label: 'P3', token: '--priority-3', description: 'Prompt — routine emergency' },
  4: { value: 4, label: 'P4', token: '--priority-4', description: 'Routine — no urgency' },
  5: { value: 5, label: 'P5', token: '--priority-5', description: 'Scheduled — administrative' },
};

export const PRIORITY_LIST: PriorityMeta[] = [1, 2, 3, 4, 5].map(
  (p) => PRIORITIES[p as IncidentPriority],
);

// ── Units ──────────────────────────────────────────────────────────────────

export type UnitTypeKey =
  | 'patrol' | 'supervisor' | 'k9' | 'air' | 'swat' | 'ems' | 'fire' | 'investigation' | 'transport';

export const UNIT_TYPES: Record<UnitTypeKey, { label: string; icon: string }> = {
  patrol: { label: 'Patrol', icon: 'Car' },
  supervisor: { label: 'Supervisor', icon: 'Star' },
  k9: { label: 'K9', icon: 'Dog' },
  air: { label: 'Air', icon: 'Plane' },
  swat: { label: 'Tactical', icon: 'Shield' },
  ems: { label: 'EMS', icon: 'Ambulance' },
  fire: { label: 'Fire', icon: 'Flame' },
  investigation: { label: 'Investigation', icon: 'Search' },
  transport: { label: 'Transport', icon: 'Truck' },
};

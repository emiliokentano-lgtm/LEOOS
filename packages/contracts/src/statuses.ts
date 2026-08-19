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

/**
 * Incident lifecycle states.
 *
 * The KEYS are the database enum and never change casually — they are in
 * indexes, CHECK constraints and stored rows. The LABELS are the operator-facing
 * vocabulary and are free to be whatever the service actually says on the radio.
 * `pending` reads as "Open" and `on_scene` reads as "Active" for exactly that
 * reason: renaming a stored enum to match a label would be a migration and a
 * data rewrite in exchange for nothing.
 *
 * `on_hold` and `cancelled` are retained. They are not part of the headline
 * lifecycle but they are real: a call can be parked pending information, and a
 * call can turn out never to have existed — which is a different outcome from
 * being resolved, and collapsing the two would corrupt the record.
 */
export type IncidentStatusKey =
  | 'pending' | 'dispatched' | 'on_scene' | 'contained' | 'on_hold' | 'closed' | 'cancelled';

export interface IncidentStatusMeta {
  readonly key: IncidentStatusKey;
  readonly label: string;
  readonly token: string;
  readonly icon: string;
  readonly isOpen: boolean;
  /** Ordering in the queue and in the status picker. */
  readonly sortOrder: number;
}

export const INCIDENT_STATUSES: Record<IncidentStatusKey, IncidentStatusMeta> = {
  pending: { key: 'pending', label: 'Open', token: '--status-busy', icon: 'Clock', isOpen: true, sortOrder: 10 },
  dispatched: { key: 'dispatched', label: 'Dispatched', token: '--status-onscene', icon: 'Send', isOpen: true, sortOrder: 20 },
  on_scene: { key: 'on_scene', label: 'Active', token: '--status-operation', icon: 'MapPin', isOpen: true, sortOrder: 30 },
  contained: { key: 'contained', label: 'Contained', token: '--status-hold', icon: 'ShieldCheck', isOpen: true, sortOrder: 40 },
  on_hold: { key: 'on_hold', label: 'On Hold', token: '--status-hold', icon: 'PauseCircle', isOpen: true, sortOrder: 50 },
  closed: { key: 'closed', label: 'Closed', token: '--status-available', icon: 'CircleCheck', isOpen: false, sortOrder: 60 },
  cancelled: { key: 'cancelled', label: 'Cancelled', token: '--status-offline', icon: 'CircleSlash', isOpen: false, sortOrder: 70 },
};

export const INCIDENT_STATUS_LIST: IncidentStatusMeta[] =
  Object.values(INCIDENT_STATUSES).sort((a, b) => a.sortOrder - b.sortOrder);

export const OPEN_INCIDENT_STATUSES: IncidentStatusKey[] =
  INCIDENT_STATUS_LIST.filter((s) => s.isOpen).map((s) => s.key);

/**
 * Priority 1 (highest) … 5 (lowest).
 *
 * NUMERIC, deliberately, and stored as an integer with a CHECK constraint. Two
 * reasons it is not a named enum:
 *
 *   • It has to ORDER. The dispatch queue is "worst first, oldest first", which
 *     is an index on `(priority, created_at)`. Ordering named values means a
 *     lookup table or a CASE expression in every query.
 *   • It is what people say. "We have a P1 at Legion Square" is the radio call;
 *     nobody says "we have a critical".
 *
 * Each level also carries a NAME, because a picker offering P1–P5 tells a new
 * dispatcher nothing. Both are shown: the badge is numeric, the picker and the
 * tooltip are worded.
 */
export type IncidentPriority = 1 | 2 | 3 | 4 | 5;

export interface PriorityMeta {
  readonly value: IncidentPriority;
  /** Radio form. Short, numeric, what goes on a dense badge. */
  readonly label: string;
  /** Worded form, for pickers and anywhere the reader may be new. */
  readonly name: string;
  readonly token: string;
  /** Response expectation, shown as a tooltip in the dispatch queue. */
  readonly description: string;
}

export const PRIORITIES: Record<IncidentPriority, PriorityMeta> = {
  1: { value: 1, label: 'P1', name: 'Critical', token: '--priority-1', description: 'Immediate — life threatening' },
  2: { value: 2, label: 'P2', name: 'High', token: '--priority-2', description: 'Urgent — rapid response' },
  3: { value: 3, label: 'P3', name: 'Medium', token: '--priority-3', description: 'Prompt — routine emergency' },
  4: { value: 4, label: 'P4', name: 'Low', token: '--priority-4', description: 'Routine — no urgency' },
  5: { value: 5, label: 'P5', name: 'Routine', token: '--priority-5', description: 'Scheduled — administrative' },
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

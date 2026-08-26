import type { OrganizationSummary } from './organizations';

/**
 * Notifications.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE PROPERTY THAT MATTERS
 *
 * A NOTIFICATION IS A PUSH OF INFORMATION, so it is subject to exactly the same
 * visibility rules as a read. Telling a PD officer "FIB unit SIERRA-2 is in
 * panic at Vespucci" leaks a covert unit's position just as surely as putting it
 * on their map — more so, because it arrives unasked.
 *
 * Recipients are therefore never named by a caller. They are DERIVED
 * server-side, inside the transaction, from membership and permission — see
 * `apps/api/src/modules/notifications/recipients.ts`. Nothing in this file
 * carries a recipient list for the same reason the FiveM telemetry type has
 * nowhere to put an organization: the shape refuses the mistake.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * SECOND PROPERTY: the type catalogue is DATA. A notification's icon, tone,
 * grouping and default sound come from the table below, so adding a type is one
 * entry here rather than a new branch in five components (engineering rules
 * 5–7).
 */

// ── Severity ───────────────────────────────────────────────────────────────

/**
 * Three levels, matching the database enum.
 *
 * `critical` is not "important" — it is *interrupting*. It is the level that
 * earns a toast that does not auto-dismiss and, if the operator has asked for
 * it, a sound. Reserve it for things that need somebody to act now: a panic, an
 * assignment to a life-threatening call.
 */
export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface NotificationSeverityMeta {
  readonly key: NotificationSeverity;
  readonly label: string;
  readonly tone: 'info' | 'warning' | 'danger';
  /** Whether a toast for this level stays until dismissed. */
  readonly sticky: boolean;
}

export const NOTIFICATION_SEVERITIES: Record<NotificationSeverity, NotificationSeverityMeta> = {
  info: { key: 'info', label: 'Info', tone: 'info', sticky: false },
  warning: { key: 'warning', label: 'Warning', tone: 'warning', sticky: false },
  critical: { key: 'critical', label: 'Critical', tone: 'danger', sticky: true },
};

// ── The type catalogue ─────────────────────────────────────────────────────

export type NotificationType =
  | 'panic.triggered'
  | 'panic.resolved'
  | 'incident.critical'
  | 'incident.assigned'
  | 'incident.updated'
  | 'incident.closed'
  | 'field_request.backup'
  | 'field_request.location'
  | 'field_request.accepted'
  | 'task.assigned'
  | 'unit.assigned'
  | 'unit.released'
  | 'organization.announcement'
  | 'admin.account_status'
  | 'admin.capability_granted'
  | 'admin.capability_revoked';

export interface NotificationTypeMeta {
  readonly key: NotificationType;
  readonly label: string;
  /** lucide-react icon name. Data, so no component maps a key to an icon. */
  readonly icon: string;
  readonly defaultSeverity: NotificationSeverity;
  /**
   * Whether this type may play a sound WHEN THE OPERATOR HAS ENABLED SOUND.
   *
   * Two gates, not one. A type that is not audible never makes a noise; a type
   * that is stays silent unless the operator turned sound on. Sound is off by
   * default — an application that starts making noise on first use is one people
   * mute permanently, and then the panic makes no noise either.
   */
  readonly audible: boolean;
  /** Grouping in the notification centre's filter. */
  readonly category: 'panic' | 'incidents' | 'units' | 'organization' | 'account';
}

export const NOTIFICATION_TYPES: Record<NotificationType, NotificationTypeMeta> = {
  'panic.triggered': {
    key: 'panic.triggered',
    label: 'Panic alert',
    icon: 'TriangleAlert',
    defaultSeverity: 'critical',
    audible: true,
    category: 'panic',
  },
  'panic.resolved': {
    key: 'panic.resolved',
    label: 'Panic resolved',
    icon: 'ShieldCheck',
    defaultSeverity: 'info',
    audible: false,
    category: 'panic',
  },
  'incident.critical': {
    key: 'incident.critical',
    label: 'Critical incident',
    icon: 'Siren',
    defaultSeverity: 'critical',
    audible: true,
    category: 'incidents',
  },
  'incident.assigned': {
    key: 'incident.assigned',
    label: 'Assigned to a call',
    icon: 'Radio',
    defaultSeverity: 'warning',
    audible: true,
    category: 'incidents',
  },
  'incident.updated': {
    key: 'incident.updated',
    label: 'Call updated',
    icon: 'PenLine',
    defaultSeverity: 'info',
    audible: false,
    category: 'incidents',
  },
  /**
   * Somebody in your organization is asking for help.
   *
   * AUDIBLE and `warning`, deliberately between a call update and a panic. It
   * is not a panic — nobody has pressed the button that means "I am in danger
   * right now" — but it is a colleague who cannot handle something alone, and an
   * alert nobody hears is an alert that did not happen.
   */
  'field_request.backup': {
    key: 'field_request.backup',
    label: 'Backup requested',
    icon: 'Siren',
    defaultSeverity: 'warning',
    audible: true,
    category: 'incidents',
  },
  /**
   * Somebody shared where they are.
   *
   * INFO and SILENT. This is passive information — nobody is waiting on it, and
   * a tone every time a colleague drops a pin would train operators to ignore
   * the tones that matter.
   */
  'field_request.location': {
    key: 'field_request.location',
    label: 'Location shared',
    icon: 'MapPin',
    defaultSeverity: 'info',
    audible: false,
    category: 'incidents',
  },
  /**
   * Work has landed on your dashboard.
   *
   * `info` and SILENT. A task has a deadline measured in hours or days; a tone
   * for one would train operators to ignore the tones that mean something is
   * happening now. The bell carries it, and the dashboard panel is where it
   * actually lives.
   */
  'task.assigned': {
    key: 'task.assigned',
    label: 'Task assigned',
    icon: 'ListChecks',
    defaultSeverity: 'info',
    audible: false,
    category: 'incidents',
  },
  /**
   * Somebody accepted your request.
   *
   * Goes to the ASKER alone, which is the one notification in this system with
   * an audience of exactly one — and even that is derived, not supplied: it is
   * the `member_id` on the row.
   */
  'field_request.accepted': {
    key: 'field_request.accepted',
    label: 'Help is coming',
    icon: 'UserCheck',
    defaultSeverity: 'warning',
    audible: true,
    category: 'incidents',
  },
  'incident.closed': {
    key: 'incident.closed',
    label: 'Call closed',
    icon: 'CircleCheck',
    defaultSeverity: 'info',
    audible: false,
    category: 'incidents',
  },
  /**
   * The two crew-change types are about YOUR unit, not about you.
   *
   * Crewing up is a self-action — nobody can put you in a car — so there is no
   * "you were added to a unit" to send. What a crew does need to know is who
   * else is in the car with them, and that their unit was stood down from under
   * them. Those are the two producers, and there are no others.
   */
  'unit.assigned': {
    key: 'unit.assigned',
    label: 'Crew joined',
    icon: 'UserPlus',
    defaultSeverity: 'info',
    audible: false,
    category: 'units',
  },
  'unit.released': {
    key: 'unit.released',
    label: 'Crew change',
    icon: 'UserMinus',
    defaultSeverity: 'info',
    audible: false,
    category: 'units',
  },
  'organization.announcement': {
    key: 'organization.announcement',
    label: 'Announcement',
    icon: 'Megaphone',
    defaultSeverity: 'info',
    audible: false,
    category: 'organization',
  },
  'admin.account_status': {
    key: 'admin.account_status',
    label: 'Account status changed',
    icon: 'UserCog',
    defaultSeverity: 'warning',
    audible: false,
    category: 'account',
  },
  'admin.capability_granted': {
    key: 'admin.capability_granted',
    label: 'Capability granted',
    icon: 'ShieldCheck',
    defaultSeverity: 'warning',
    audible: false,
    category: 'account',
  },
  'admin.capability_revoked': {
    key: 'admin.capability_revoked',
    label: 'Capability revoked',
    icon: 'ShieldOff',
    defaultSeverity: 'warning',
    audible: false,
    category: 'account',
  },
};

export const NOTIFICATION_TYPE_KEYS = Object.keys(NOTIFICATION_TYPES) as NotificationType[];

export type NotificationCategory = NotificationTypeMeta['category'];

export const NOTIFICATION_CATEGORIES: { key: NotificationCategory; label: string }[] = [
  { key: 'panic', label: 'Panic' },
  { key: 'incidents', label: 'Incidents' },
  { key: 'units', label: 'Units' },
  { key: 'organization', label: 'Organization' },
  { key: 'account', label: 'Account' },
];

/** Unknown types are rendered generically rather than crashing a shipped client. */
export function notificationTypeMeta(key: string): NotificationTypeMeta {
  return NOTIFICATION_TYPES[key as NotificationType] ?? {
    key: key as NotificationType,
    label: key,
    icon: 'Bell',
    defaultSeverity: 'info',
    audible: false,
    category: 'organization',
  };
}

// ── When an incident is worth interrupting somebody for ────────────────────

/**
 * The priority at which a NEW call raises a notification rather than simply
 * appearing on the board.
 *
 * P1 is named "Critical — immediate, life threatening" in the priority
 * catalogue, and that is the line. Notifying on P2 as well would double the
 * traffic to buy very little: a dispatcher watching the board sees a P2 land
 * live, and a dispatcher not watching the board is not the person a P2 needs.
 *
 * Written here rather than in the dispatch service so the screen that explains
 * the rule and the service that applies it read the same number.
 */
export const CRITICAL_INCIDENT_PRIORITY = 1;

export function isCriticalIncident(priority: number): boolean {
  return priority <= CRITICAL_INCIDENT_PRIORITY;
}

// ── The notification itself ────────────────────────────────────────────────

/**
 * What the recipient is shown.
 *
 * `href` is a deep link the API composes, because the API is what knows whether
 * the subject still exists. A client building its own link from `entityId` would
 * happily produce a route to an incident that was deleted an hour ago.
 */
export interface NotificationDto {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  href: string | null;
  entityType: string | null;
  entityId: string | null;
  organization: OrganizationSummary | null;
  /**
   * Context the detail view renders as a list.
   *
   * Passed through rather than formatted into the body, for the same reason the
   * audit log does it: the metadata of a panic and of an announcement have
   * nothing in common.
   */
  metadata: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPage {
  notifications: NotificationDto[];
  /** Unread across EVERYTHING, not just this page — it drives the badge. */
  unreadCount: number;
  /** Null when this is the last page. */
  nextCursor: string | null;
}

export interface NotificationQuery {
  /** Only unread. The centre's default view is everything, not this. */
  unreadOnly?: boolean;
  category?: NotificationCategory;
  severity?: NotificationSeverity;
  limit?: number;
  cursor?: string;
}

/**
 * The badge.
 *
 * `criticalUnread` is separate because a bell showing "12" says nothing about
 * whether one of them is a panic. The badge colour comes from this.
 */
export interface UnreadSummary {
  total: number;
  critical: number;
}

// ── Preferences ────────────────────────────────────────────────────────────

/**
 * What the operator has asked for.
 *
 * Deliberately small. Every switch here is one an operator would actually reach
 * for during a shift; a preference nobody changes is a row in a table and a
 * branch in the code forever.
 *
 * SOUND IS OFF BY DEFAULT. An application that makes noise on first use is one
 * people mute at the operating-system level — and then the panic makes no noise
 * either, which is worse than never having had sound at all.
 */
export interface NotificationPreferences {
  /** Master switch. Off by default. */
  soundEnabled: boolean;
  /**
   * Only critical notifications make a sound, even when sound is on.
   *
   * On by default, because a dispatcher receiving thirty routine updates an hour
   * will otherwise turn sound off within a shift and lose the panic tone too.
   */
  soundCriticalOnly: boolean;
  /** 0–100. Applied to the tone, not to the browser. */
  soundVolume: number;
  /** Whether a critical notification raises a toast that stays until dismissed. */
  criticalToasts: boolean;
  /** Categories the operator has muted in-app. Panic can never be muted. */
  mutedCategories: NotificationCategory[];
  /**
   * Sound cues the operator has silenced individually.
   *
   * Separate from `mutedCategories`, which hides a notification's banner — this
   * only takes away its sound, and it also covers cues that are not
   * notifications at all (the status confirmation). Panic can never be
   * silenced; see UNMUTABLE_CUES in ./sound.
   */
  mutedCues: string[];
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  soundEnabled: false,
  soundCriticalOnly: true,
  soundVolume: 60,
  criticalToasts: true,
  mutedCategories: [],
  mutedCues: [],
};

/**
 * Panic is never mutable.
 *
 * Not a UI decision — enforced here, where both the client and the server read
 * it. An operator who has muted "panic" is an operator who will not answer one,
 * and the whole point of the alert is that it reaches somebody.
 */
export const UNMUTABLE_CATEGORIES: NotificationCategory[] = ['panic'];

export function canMuteCategory(category: NotificationCategory): boolean {
  return !UNMUTABLE_CATEGORIES.includes(category);
}

/**
 * Should this notification make a sound for this operator?
 *
 * One function, used by the client to decide whether to play and by the tests to
 * assert the policy. Three gates in order: the type must be audible at all, the
 * operator must have enabled sound, and the critical-only filter must pass.
 */
export function shouldPlaySound(
  type: string,
  severity: NotificationSeverity,
  preferences: NotificationPreferences,
): boolean {
  if (!preferences.soundEnabled) return false;
  if (!notificationTypeMeta(type).audible) return false;
  if (preferences.soundCriticalOnly && severity !== 'critical') return false;
  return true;
}

/** Should this notification appear in the operator's feed at all? */
export function isMuted(type: string, preferences: NotificationPreferences): boolean {
  const category = notificationTypeMeta(type).category;
  if (!canMuteCategory(category)) return false;
  return preferences.mutedCategories.includes(category);
}

// ── Announcements ──────────────────────────────────────────────────────────

/**
 * An organization-wide message.
 *
 * The only notification type a human composes directly, which is why it is the
 * only one with an input shape. Everything else is emitted by the domain event
 * that caused it — a notification nobody can send by hand is a notification that
 * cannot be forged.
 */
export interface AnnouncementInput {
  title: string;
  body: string;
  severity: NotificationSeverity;
}

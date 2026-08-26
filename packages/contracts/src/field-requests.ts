import type { OrganizationSummary } from './organizations';

/**
 * Asking for help, and saying where you are.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE SHAPE, TWO OUTCOMES
 *
 * A backup request and a location share are the same event: somebody in the
 * field raises something, their colleagues are offered it, and each of them
 * takes it or dismisses it. What differs is only what ACCEPTING does.
 *
 *   backup          → the accepting unit is assigned to the asker's call, if
 *                     they have one, through the ordinary assignment path.
 *   location_share  → a marker, and nothing else. It is information, not
 *                     dispatch, and it attaches nobody to anything.
 *
 * Modelling them separately would have duplicated the lifecycle, the audience
 * derivation, the expiry rule and the authorization — four things it is
 * important not to have two of.
 * ────────────────────────────────────────────────────────────────────────────
 */
export type FieldRequestKind = 'backup' | 'location_share';

export type FieldRequestStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  /** The asker withdrew it. */
  | 'cancelled'
  /** Nobody took it in time. Silence is not refusal, so this is not `declined`. */
  | 'expired';

export interface FieldRequestKindMeta {
  key: FieldRequestKind;
  label: string;
  /** What the person raising it is doing, in their words. */
  actionLabel: string;
  icon: string;
  /** Whether accepting attaches the acceptor to the asker's call. */
  attaches: boolean;
  /** How long it stays live. */
  ttlMs: number;
}

/**
 * The catalogue, as data.
 *
 * Adding a third kind — "requesting a supervisor", say — is an entry here plus
 * a branch in one service, not a new table and five new components.
 */
export const FIELD_REQUEST_KINDS: Record<FieldRequestKind, FieldRequestKindMeta> = {
  backup: {
    key: 'backup',
    label: 'Backup',
    actionLabel: 'Request backup',
    icon: 'Siren',
    attaches: true,
    /**
     * Three minutes.
     *
     * A backup request nobody has taken in three minutes has been answered by
     * events one way or the other, and a prompt that surfaces after that is
     * confusion rather than help.
     */
    ttlMs: 3 * 60_000,
  },
  location_share: {
    key: 'location_share',
    label: 'Location',
    actionLabel: 'Share my location',
    icon: 'MapPin',
    attaches: false,
    /**
     * Fifteen minutes — longer because it is passive and nobody is waiting on
     * it, but still finite: a position from an hour ago is worse than none.
     */
    ttlMs: 15 * 60_000,
  },
};

export const FIELD_REQUEST_KIND_KEYS = Object.keys(FIELD_REQUEST_KINDS) as FieldRequestKind[];

/** Unknown kinds render generically rather than crashing a shipped client. */
export function fieldRequestKindMeta(kind: string): FieldRequestKindMeta {
  return FIELD_REQUEST_KINDS[kind as FieldRequestKind] ?? {
    key: kind as FieldRequestKind,
    label: kind,
    actionLabel: kind,
    icon: 'CircleHelp',
    attaches: false,
    ttlMs: 3 * 60_000,
  };
}

/** Who raised it. Identifiers and the handful of fields a prompt shows. */
export interface FieldRequestAsker {
  memberId: string;
  displayName: string;
  callsign: string | null;
  rankLabel: string | null;
}

/**
 * A live or recent field request.
 *
 * NOTE WHAT IS ABSENT: a recipient list. The audience is derived server-side
 * from membership and duty status, so there is nowhere to put one and no
 * endpoint that accepts one — the same rule the notification system holds.
 */
export interface FieldRequestDto {
  id: string;
  kind: FieldRequestKind;
  status: FieldRequestStatus;
  organization: OrganizationSummary;
  asker: FieldRequestAsker;
  unitId: string | null;
  unitCallsign: string | null;
  /** The call the asker was on when they raised it, if any. */
  incidentId: string | null;
  incidentNumber: string | null;
  x: number | null;
  y: number | null;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  /** Display name of whoever accepted. Null unless `status === 'accepted'`. */
  acceptedBy: string | null;
  /**
   * How many people dismissed it.
   *
   * Shown because "eight people declined" is a different fact from "nobody
   * saw it", and a supervisor reviewing why help did not arrive needs to be
   * able to tell them apart.
   */
  declinedCount: number;
  /** What the CALLER did about it, so a client need not work it out. */
  viewerResponse: 'accepted' | 'declined' | null;
  /** True when the caller raised it — the only person who may cancel it. */
  viewerIsAsker: boolean;
}

export interface FieldRequestListDto {
  requests: FieldRequestDto[];
  /** Bumped whenever anything here changes, for the same poll the board uses. */
  revision: string;
}

/** What a client may send. Deliberately tiny: everything else is derived. */
export interface RaiseFieldRequestInput {
  kind: FieldRequestKind;
  /**
   * Optional, and bounded. A note is the one free-text field, so it is the one
   * thing here that needs a length limit and a redaction thought: it reaches
   * every on-duty colleague, so it must never be treated as private.
   */
  note?: string | null;
  x?: number | null;
  y?: number | null;
}

/**
 * A request is live if it is pending AND its deadline has not passed.
 *
 * ONE FUNCTION, used by the API's read path and by the browser, so a client
 * cannot show an "Accept" button for something the server will refuse. Takes
 * the clock as an argument rather than reading it, so the predicate stays pure
 * and testable — the same shape `matchesUnitFilter` uses on the map.
 */
export function isFieldRequestLive(
  request: Pick<FieldRequestDto, 'status' | 'expiresAt'>,
  now: number,
): boolean {
  if (request.status !== 'pending') return false;
  return Date.parse(request.expiresAt) > now;
}

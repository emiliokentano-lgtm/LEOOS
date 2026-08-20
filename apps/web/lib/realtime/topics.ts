import type { RealtimeEventType } from '@leoos/contracts';

/**
 * Which topics a screen asks for.
 *
 * THE CLIENT NAMES TOPICS; THE SERVER DECIDES. Nothing here is a permission
 * check — a screen may cheerfully ask for a topic this account cannot have, and
 * the server denies it and sends nothing (`apps/api/src/realtime/topics.ts`).
 * Keeping the list here rather than deriving it from the client's cosmetic
 * permission copy means "what is this screen receiving" is answerable by reading
 * one function, and that a bug in the client's idea of its own permissions can
 * only ever cost it data, never gain it any.
 */

export interface TopicScope {
  userId: string;
  /** The organization the operator is acting in. Null for an account with none. */
  organizationId: string | null;
}

function organizationTopics(organizationId: string | null, kinds: readonly string[]): string[] {
  if (organizationId === null) return [];
  return kinds.map((kind) => `org:${organizationId}:${kind}`);
}

/**
 * The dispatch board.
 *
 * Incidents, units and panic for the operator's own service. Not personnel: the
 * board shows units, and a roster feed is a higher bar than the board is.
 */
export function dispatchTopics(scope: TopicScope): string[] {
  return [
    `user:${scope.userId}`,
    ...organizationTopics(scope.organizationId, ['incidents', 'units', 'panic']),
  ];
}

/**
 * The dashboard.
 *
 * Everything the board watches, plus personnel — the dashboard reports how many
 * people are on duty, and the brief asks it to update when a personnel status
 * changes. A caller without `personnel.view` is simply denied that one topic and
 * keeps the rest.
 */
export function dashboardTopics(scope: TopicScope): string[] {
  return [
    `user:${scope.userId}`,
    ...organizationTopics(scope.organizationId, ['incidents', 'units', 'panic', 'personnel']),
  ];
}

/**
 * The map.
 *
 * `map:units` carries positions and is the only high-rate topic in the system.
 * The organization topics come too: a unit changing status or going on a call
 * changes how its marker is drawn, and those arrive as dispatch events rather
 * than as position samples.
 */
export function mapTopics(scope: TopicScope): string[] {
  return [
    'map:units',
    ...organizationTopics(scope.organizationId, ['incidents', 'units', 'panic']),
  ];
}

/**
 * Events that mean a dispatch-shaped screen should refetch.
 *
 * Position batches are deliberately ABSENT. They arrive once a second and are
 * applied directly to the map's own state; treating one as "your board is
 * stale" would turn a 1 Hz position feed into a 1 Hz board refetch, which is
 * exactly the load the batching exists to avoid.
 */
export const BOARD_EVENTS: readonly RealtimeEventType[] = [
  'incident.created',
  'incident.updated',
  'incident.assigned',
  'incident.closed',
  'unit.created',
  'unit.updated',
  'unit.status.updated',
  'unit.member.joined',
  'unit.member.left',
  'panic.triggered',
  'panic.resolved',
  'personnel.updated',
];

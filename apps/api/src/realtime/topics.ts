import { can, type ActorContext } from '@leoos/authz-core';
import { parseTopic, type DenyReason, type Topic } from '@leoos/contracts';

/**
 * Topic authorization — THE SECURITY BOUNDARY OF THE REAL-TIME FEED.
 *
 * The brief's example is the whole point: a PD user must not automatically
 * receive FIB-only events. That is achieved by never writing them to their
 * socket, not by a client-side filter — anything delivered to a browser is
 * readable by whoever is sitting at it.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE.
 *
 *   1. A topic is authorized from the SUBSCRIBER'S OWN live context, never from
 *      anything they sent. The organization in a topic string is matched against
 *      the organizations that subscriber actually belongs to; a crafted topic
 *      naming someone else's organization is a denial, not a subscription.
 *
 *   2. Authorization is RE-EVALUATED ON EVERY DELIVERY, not cached at subscribe
 *      time. A socket open across a demotion, a transfer, or a termination stops
 *      receiving the moment the permission goes — with no revocation machinery,
 *      because there is nothing cached to revoke.
 *
 * The second rule is why `authorizeTopic` takes a fresh `ActorContext` rather
 * than a boolean computed earlier. It is called on the subscribe path AND on the
 * fan-out path.
 */

export interface TopicDecision {
  allowed: boolean;
  reason?: DenyReason;
}

const ALLOW: TopicDecision = { allowed: true };

function deny(reason: DenyReason): TopicDecision {
  return { allowed: false, reason };
}

/**
 * May this actor subscribe to — and receive on — this topic?
 *
 * `actorUserId` is passed separately because `ActorContext` deliberately carries
 * no session identity; it is a pure authorization value object.
 */
export function authorizeTopic(
  actor: ActorContext,
  actorUserId: string,
  topic: Topic,
): TopicDecision {
  switch (topic.kind) {
    /**
     * Your own notifications, and only your own.
     *
     * The one topic where the subscriber names an id — so it is compared against
     * the authenticated user and nothing else. No permission grants access to
     * another person's notification stream, including a global administrator's:
     * there is no operational reason to read someone else's toasts, and the
     * capability would be pure surveillance.
     */
    case 'user':
      return topic.userId === actorUserId ? ALLOW : deny('not-permitted');

    /**
     * Live positions.
     *
     * Gated on `map.track_units`, and the payload is filtered per subscriber
     * again at fan-out — covert units are excluded there, because a subscriber
     * who may track units generally may still not track a particular one
     * (docs/architecture/05-map.md §5).
     */
    case 'map.units':
      return can(actor, 'map.track_units') || can(actor, 'map.track_all_orgs')
        ? ALLOW
        : deny('not-permitted');

    case 'org.units':
    case 'org.incidents':
    case 'org.panic':
      if (topic.organizationId === null) return deny('malformed-topic');
      if (!belongsToOrganization(actor, topic.organizationId)) return deny('not-permitted');
      return can(actor, 'dispatch.view') ? ALLOW : deny('not-permitted');

    /**
     * Personnel status changes.
     *
     * A higher bar than the dispatch topics: knowing who is on duty across a
     * whole service is a roster, and the screen that shows it is gated on
     * `personnel.view`. The feed matches the screen — search taught us that a
     * second, weaker door into the same data is exactly how things leak.
     */
    case 'org.personnel':
      if (topic.organizationId === null) return deny('malformed-topic');
      if (!belongsToOrganization(actor, topic.organizationId)) return deny('not-permitted');
      return can(actor, 'personnel.view') ? ALLOW : deny('not-permitted');
  }
}

/**
 * Whether the actor may see this organization's operational traffic at all.
 *
 * The active organization, or unrestricted for a global administrator — the same
 * rule the dispatch and map scopes use. Deliberately NOT "every organization
 * they have ever belonged to": the active-organization header is already
 * validated against their memberships, and acting as PD should not stream MD's
 * board.
 */
function belongsToOrganization(actor: ActorContext, organizationId: string): boolean {
  if (actor.isGlobalAdmin || actor.globalCapabilities.has('org_admin')) return true;
  return actor.organizationId === organizationId;
}

/**
 * Parses and authorizes in one step.
 *
 * A topic that will not parse is refused rather than raising: clients send
 * arbitrary text, and malformed input is a denial, not a server error.
 */
export function evaluateTopic(
  actor: ActorContext,
  actorUserId: string,
  raw: string,
): { topic: Topic | null; decision: TopicDecision } {
  const topic = parseTopic(raw);
  if (topic === null) return { topic: null, decision: deny('malformed-topic') };
  return { topic, decision: authorizeTopic(actor, actorUserId, topic) };
}

/**
 * The topics a client should subscribe to for a given screen.
 *
 * Exported so the server can suggest them and the tests can assert the set. The
 * client still asks explicitly — the server never subscribes anyone to anything
 * they did not request, which keeps "what am I receiving" answerable from the
 * client's own code.
 */
export function topicsForScreen(
  screen: 'dashboard' | 'dispatch' | 'map',
  organizationId: string | null,
  userId: string,
): string[] {
  const topics: string[] = [`user:${userId}`];
  if (organizationId !== null) {
    topics.push(`org:${organizationId}:incidents`);
    topics.push(`org:${organizationId}:units`);
    topics.push(`org:${organizationId}:panic`);
    if (screen !== 'map') topics.push(`org:${organizationId}:personnel`);
  }
  if (screen === 'map') topics.push('map:units');
  return topics;
}

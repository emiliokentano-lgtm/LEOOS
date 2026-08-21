import {
  notificationTypeMeta,
  type NotificationDto, type NotificationSeverity, type NotificationType,
  type OrganizationCategory, type OrganizationSummary,
} from '@leoos/contracts';
import type { NotificationRow } from './notification.service.js';

/**
 * The serialization boundary for notifications (engineering rule 16).
 *
 * Every response is assembled here from a typed DTO rather than from a row. It
 * matters more than usual on this table: a notification row carries a
 * `metadata` blob whose contents vary by type, and handing the raw row to the
 * client would mean the shape of what leaves the API depends on whatever a
 * service happened to put in that blob six months ago.
 *
 * Nothing about the ROW ITSELF is sensitive — a notification is by construction
 * something its owner has already been told. What this boundary buys is that the
 * field list is explicit and reviewable, so a column added to the table does not
 * silently start appearing in responses.
 */

const iso = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const isoRequired = (value: Date | string): string => iso(value) as string;

/**
 * Unknown severities degrade to `info`, they do not throw.
 *
 * A row written by an older build with a level this one does not know about
 * should render as a quiet notification, not break the whole centre for its
 * owner. The same reasoning as `notificationTypeMeta`'s generic fallback.
 */
function severityOf(value: string): NotificationSeverity {
  return value === 'critical' || value === 'warning' ? value : 'info';
}

function organizationOf(row: NotificationRow): OrganizationSummary | null {
  if (row.organizationId === null || row.organizationKey === null) return null;
  return {
    id: row.organizationId,
    key: row.organizationKey,
    name: row.organizationName ?? row.organizationKey,
    shortName: row.organizationShortName ?? row.organizationKey,
    category: (row.organizationCategory ?? 'other') as OrganizationCategory,
    color: row.organizationColor ?? '#64748b',
  };
}

export function toNotificationDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    // Passed through as written rather than validated against the catalogue: a
    // type this build does not know is rendered generically by
    // `notificationTypeMeta`, which is better than dropping the row.
    type: notificationTypeMeta(row.type).key as NotificationType,
    severity: severityOf(row.severity),
    title: row.title,
    body: row.body,
    href: row.href,
    entityType: row.entityType,
    entityId: row.entityId,
    organization: organizationOf(row),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: isoRequired(row.createdAt),
    readAt: iso(row.readAt),
  };
}

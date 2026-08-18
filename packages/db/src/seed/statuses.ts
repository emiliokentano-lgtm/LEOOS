import { DUTY_STATUS_LIST } from '@leoos/contracts';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { operationalStatus } from '../schema/index.js';

/**
 * Seeds the default operational-status catalogue from `@leoos/contracts`.
 *
 * These are DEFAULTS, not a ceiling: `operational_status` is a table precisely so
 * an organization can add its own statuses without a code change or migration
 * (engineering rules 5-7). Seeded rows have `organization_id = NULL`, meaning
 * available to every organization.
 */
export async function seedOperationalStatuses(db: Database): Promise<number> {
  const rows = DUTY_STATUS_LIST.map((s) => ({
    key: s.key,
    label: s.label,
    shortLabel: s.short,
    colorToken: s.token,
    icon: s.icon,
    isAvailable: s.isAvailable,
    isOnDuty: s.isOnDuty,
    sortOrder: s.sortOrder,
    organizationId: null,
  }));

  await db
    .insert(operationalStatus)
    .values(rows)
    .onConflictDoUpdate({
      target: operationalStatus.key,
      set: {
        label: sql`excluded.label`,
        shortLabel: sql`excluded.short_label`,
        colorToken: sql`excluded.color_token`,
        icon: sql`excluded.icon`,
        isAvailable: sql`excluded.is_available`,
        isOnDuty: sql`excluded.is_on_duty`,
        sortOrder: sql`excluded.sort_order`,
      },
    });

  return rows.length;
}

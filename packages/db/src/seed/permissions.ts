import { PERMISSION_KEYS, permissionMeta } from '@leoos/contracts';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { permission } from '../schema/index.js';

/**
 * Seeds the permission catalogue FROM `@leoos/contracts`.
 *
 * The contracts object is the single source of truth; this function projects it
 * into the database so `role_permission` can carry a real foreign key. The two
 * are never maintained independently — that is what `verifyPermissionCatalogue`
 * below exists to prove, and what CI runs on every build.
 */
export async function seedPermissions(db: Database): Promise<number> {
  const rows = PERMISSION_KEYS.map((key) => {
    const meta = permissionMeta(key);
    return {
      key,
      category: meta.category,
      label: meta.label,
      scope: meta.scope ?? ('organization' as const),
      risk: meta.risk,
    };
  });

  await db
    .insert(permission)
    .values(rows)
    .onConflictDoUpdate({
      target: permission.key,
      set: {
        category: sql`excluded.category`,
        label: sql`excluded.label`,
        scope: sql`excluded.scope`,
        risk: sql`excluded.risk`,
      },
    });

  return rows.length;
}

export interface CatalogueDrift {
  missingInDatabase: string[];
  extraInDatabase: string[];
  mismatched: { key: string; field: string; contracts: string; database: string }[];
}

/**
 * Detects divergence between the contracts catalogue and the seeded table.
 *
 * A permission key that exists in one and not the other is a silent
 * authorization hole: the UI offers a permission the database cannot store, or
 * the database holds grants for a permission nothing checks. CI fails on any
 * drift (engineering rule 7).
 */
export async function verifyPermissionCatalogue(db: Database): Promise<CatalogueDrift> {
  const stored = await db.select().from(permission);
  const storedByKey = new Map(stored.map((row) => [row.key, row]));
  const contractKeys = new Set<string>(PERMISSION_KEYS);

  const drift: CatalogueDrift = {
    missingInDatabase: [],
    extraInDatabase: stored.filter((r) => !contractKeys.has(r.key)).map((r) => r.key),
    mismatched: [],
  };

  for (const key of PERMISSION_KEYS) {
    const row = storedByKey.get(key);
    if (!row) {
      drift.missingInDatabase.push(key);
      continue;
    }
    const meta = permissionMeta(key);
    const expectedScope = meta.scope ?? 'organization';
    if (row.scope !== expectedScope) {
      drift.mismatched.push({
        key, field: 'scope', contracts: expectedScope, database: row.scope,
      });
    }
    if (row.risk !== meta.risk) {
      drift.mismatched.push({ key, field: 'risk', contracts: meta.risk, database: row.risk });
    }
    if (row.category !== meta.category) {
      drift.mismatched.push({
        key, field: 'category', contracts: meta.category, database: row.category,
      });
    }
  }

  return drift;
}

export function hasDrift(drift: CatalogueDrift): boolean {
  return (
    drift.missingInDatabase.length > 0 ||
    drift.extraInDatabase.length > 0 ||
    drift.mismatched.length > 0
  );
}

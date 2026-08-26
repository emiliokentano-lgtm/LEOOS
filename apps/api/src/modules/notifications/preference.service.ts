import { eq, sql } from 'drizzle-orm';
import { notificationPreference, type Database } from '@leoos/db';
import {
  DEFAULT_NOTIFICATION_PREFERENCES, canMuteCategory, canMuteCue, isKnownCue,
  type NotificationCategory, type NotificationPreferences,
} from '@leoos/contracts';

/**
 * Per-operator notification preferences.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A MISSING ROW IS THE DEFAULT, NOT AN ERROR
 *
 * No row is created at registration. `read` falls back to
 * `DEFAULT_NOTIFICATION_PREFERENCES` from the contracts package — the same
 * object the browser uses before its first fetch resolves — so the two tiers
 * cannot disagree about what "not configured" means. Seeding a row per account
 * would put the defaults in two places and guarantee they drift the first time
 * one is changed.
 *
 * PANIC CANNOT BE MUTED, AND THAT IS ENFORCED HERE.
 *
 * The UI does not offer it, but the UI is not the enforcement point (engineering
 * rule 9). `panic` is stripped from any incoming list, and the table carries a
 * CHECK constraint saying the same thing, so neither a crafted request nor a
 * support script editing the row directly can produce an operator who will not
 * be told somebody is in trouble.
 * ────────────────────────────────────────────────────────────────────────────
 */

export async function readPreferences(
  db: Database,
  userId: string,
): Promise<NotificationPreferences> {
  const rows = await db
    .select()
    .from(notificationPreference)
    .where(eq(notificationPreference.userId, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };

  return {
    soundEnabled: row.soundEnabled,
    soundCriticalOnly: row.soundCriticalOnly,
    soundVolume: row.soundVolume,
    criticalToasts: row.criticalToasts,
    mutedCategories: sanitizeCategories(row.mutedCategories),
    mutedCues: sanitizeCues(row.mutedCues),
  };
}

/**
 * Drops anything that is not a silenceable cue.
 *
 * The same treatment `sanitizeCategories` gets, and for the same reason: a row
 * that somehow contains `panic` — an old backup, a hand-edited row — must not
 * produce a client that silently plays nothing for a panic. It produces a
 * client that plays it, and the next write cleans the row up.
 */
function sanitizeCues(values: readonly string[]): string[] {
  return values.filter((value) => isKnownCue(value) && canMuteCue(value));
}

/**
 * Drops anything that is not a mutable category.
 *
 * Applied on the way OUT as well as on the way in. A row that somehow contains
 * `panic` — restored from an old backup, edited by hand — must not produce a
 * client that silently hides panic alerts; it produces a client that shows them,
 * and the next write cleans the row up.
 */
function sanitizeCategories(values: readonly string[]): NotificationCategory[] {
  const known: NotificationCategory[] = ['panic', 'incidents', 'units', 'organization', 'account'];
  return values
    .filter((value): value is NotificationCategory =>
      (known as string[]).includes(value) && canMuteCategory(value as NotificationCategory));
}

export type PreferenceUpdate = Partial<NotificationPreferences>;

/**
 * Writes preferences, creating the row on first use.
 *
 * An upsert rather than a read-then-insert: two tabs saving at once is ordinary,
 * and the primary key on `user_id` makes the race resolve into one row instead
 * of a unique-violation 500.
 *
 * Returns the STORED state, not the requested one, so a client that asked to
 * mute panic sees that it did not happen rather than rendering as though it had.
 */
export async function writePreferences(
  db: Database,
  userId: string,
  update: PreferenceUpdate,
): Promise<NotificationPreferences> {
  const current = await readPreferences(db, userId);
  const next: NotificationPreferences = {
    soundEnabled: update.soundEnabled ?? current.soundEnabled,
    soundCriticalOnly: update.soundCriticalOnly ?? current.soundCriticalOnly,
    soundVolume: clampVolume(update.soundVolume ?? current.soundVolume),
    criticalToasts: update.criticalToasts ?? current.criticalToasts,
    mutedCategories: sanitizeCategories(update.mutedCategories ?? current.mutedCategories),
    mutedCues: sanitizeCues(update.mutedCues ?? current.mutedCues),
  };

  await db
    .insert(notificationPreference)
    .values({
      userId,
      soundEnabled: next.soundEnabled,
      soundCriticalOnly: next.soundCriticalOnly,
      soundVolume: next.soundVolume,
      criticalToasts: next.criticalToasts,
      mutedCategories: next.mutedCategories,
      mutedCues: next.mutedCues,
    })
    .onConflictDoUpdate({
      target: notificationPreference.userId,
      set: {
        soundEnabled: next.soundEnabled,
        soundCriticalOnly: next.soundCriticalOnly,
        soundVolume: next.soundVolume,
        criticalToasts: next.criticalToasts,
        mutedCategories: next.mutedCategories,
        mutedCues: next.mutedCues,
        updatedAt: sql`now()`,
      },
    });

  return next;
}

/** Belt and braces with the CHECK constraint; a 0–100 slider, clamped. */
function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_NOTIFICATION_PREFERENCES.soundVolume;
  return Math.min(100, Math.max(0, Math.round(value)));
}

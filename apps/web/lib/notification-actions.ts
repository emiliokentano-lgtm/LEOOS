'use server';

import type { NotificationPreferences, UnreadSummary } from '@leoos/contracts';
import { apiFetch } from './api-client';

/**
 * Notification mutations.
 *
 * Reads go through Route Handlers (`app/api/notifications/*`) because the shell
 * polls them; these are the writes, and they are server actions for the same
 * reason every other mutation in this application is — the session cookie and
 * the CSRF token are handled in one place, and a mutation that a client could
 * issue directly against the API from the browser would be a second path with
 * its own bugs.
 *
 * Nothing here names a user. Marking read, marking all read and saving
 * preferences all resolve their subject from the session at the API, so there is
 * no argument any of these functions could be given that would touch somebody
 * else's feed.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface MarkReadResult extends ActionResult {
  /** The badge AFTER the change, so the caller does not have to re-poll. */
  unread?: UnreadSummary;
}

export async function markNotificationsRead(
  notificationIds: string[],
): Promise<MarkReadResult> {
  if (notificationIds.length === 0) return { ok: true };

  const res = await apiFetch<{ updated: number; unread: UnreadSummary }>(
    '/api/v1/notifications/read',
    { method: 'POST', body: { notificationIds } },
  );
  if (!res.ok || !res.data) {
    return { ok: false, error: res.error?.message ?? 'Could not mark those as read.' };
  }
  return { ok: true, unread: res.data.unread };
}

export async function markAllNotificationsRead(): Promise<MarkReadResult> {
  const res = await apiFetch<{ updated: number; unread: UnreadSummary }>(
    '/api/v1/notifications/read-all',
    { method: 'POST', body: {} },
  );
  if (!res.ok || !res.data) {
    return { ok: false, error: res.error?.message ?? 'Could not mark everything as read.' };
  }
  return { ok: true, unread: res.data.unread };
}

export interface PreferencesResult extends ActionResult {
  /**
   * The STORED preferences, not the requested ones.
   *
   * An operator who tried to mute panic gets back a value in which it is not
   * muted, and the switch snaps back. Echoing the request would produce a client
   * that believes it silenced something the server will keep sending.
   */
  preferences?: NotificationPreferences;
}

export async function loadNotificationPreferences(): Promise<PreferencesResult> {
  const res = await apiFetch<NotificationPreferences>('/api/v1/notifications/preferences');
  if (!res.ok || !res.data) {
    return { ok: false, error: res.error?.message ?? 'Could not load your settings.' };
  }
  return { ok: true, preferences: res.data };
}

export async function saveNotificationPreferences(
  update: Partial<NotificationPreferences>,
): Promise<PreferencesResult> {
  const res = await apiFetch<NotificationPreferences>('/api/v1/notifications/preferences', {
    method: 'PUT',
    body: update,
  });
  if (!res.ok || !res.data) {
    return { ok: false, error: res.error?.message ?? 'Could not save your settings.' };
  }
  return { ok: true, preferences: res.data };
}

export async function sendAnnouncement(
  organizationId: string,
  input: { title: string; body: string; severity: 'info' | 'warning' },
): Promise<ActionResult & { recipients?: number }> {
  const res = await apiFetch<{ recipients: number }>(
    `/api/v1/notifications/announcements/${organizationId}`,
    { method: 'POST', body: input },
  );
  if (!res.ok || !res.data) {
    return { ok: false, error: res.error?.message ?? 'The announcement was not sent.' };
  }
  return { ok: true, recipients: res.data.recipients };
}

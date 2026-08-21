'use client';

import * as React from 'react';
import {
  BACKSTOP_POLL_MS, DEFAULT_NOTIFICATION_PREFERENCES, NOTIFICATION_SEVERITIES,
  isMuted, shouldPlaySound,
  type NotificationDto, type NotificationPreferences, type RealtimeEvent,
  type UnreadSummary,
} from '@leoos/contracts';
import { useToast } from '@/components/ui';
import { useRealtime } from '@/lib/realtime/realtime-context';
import {
  loadNotificationPreferences, markAllNotificationsRead, markNotificationsRead,
  saveNotificationPreferences,
} from '@/lib/notification-actions';
import { playAlertTone } from '@/lib/notifications/alert-tone';
import { useAuth } from './auth-context';

/**
 * Notifications, for the shell.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE EVENT SAYS SOMETHING ARRIVED; THE AUTHORIZED READ SAYS WHAT
 *
 * Every other live screen in this application works this way, and this one is no
 * exception. The socket payload carries an id, a type, a severity and a
 * headline — enough to raise a toast and decide about sound — and then the head
 * of the list is refetched. The list is what the centre renders.
 *
 * Two reasons, and the second is the one that actually forces it:
 *
 *   1. Patching state from a payload would mean the payload had to carry
 *      everything the centre shows, including the deep link and the metadata —
 *      which is how a feed ends up broadcasting more than the screen needs.
 *   2. THE BADGE CANNOT BE COMPUTED FROM EVENTS. The same person reading a
 *      notification in another tab lowers the count with no event at all. Only
 *      the server knows the number, so the server is asked.
 *
 * The socket is the fast path. A slow poll runs behind it — the same backstop
 * interval the rest of the shell uses — so a console that has lost its socket
 * still shows a right badge within half a minute rather than looking calm.
 * ────────────────────────────────────────────────────────────────────────────
 */

interface NotificationContextValue {
  notifications: NotificationDto[];
  unread: UnreadSummary;
  loading: boolean;
  /** Null until the first load succeeds; the API is the authority, not this. */
  error: string | null;
  preferences: NotificationPreferences;
  refresh: () => void;
  markRead: (ids: string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  savePreferences: (update: Partial<NotificationPreferences>) => Promise<{
    ok: boolean; error?: string;
  }>;
}

const NotificationContext = React.createContext<NotificationContextValue | null>(null);

export function useNotifications(): NotificationContextValue {
  const ctx = React.useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used inside <NotificationProvider>');
  return ctx;
}

/** How much of the feed the bell holds. The centre pages beyond it. */
const HEAD_PAGE_SIZE = 20;

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const toast = useToast();

  const [notifications, setNotifications] = React.useState<NotificationDto[]>([]);
  const [unread, setUnread] = React.useState<UnreadSummary>({ total: 0, critical: 0 });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [preferences, setPreferences] = React.useState<NotificationPreferences>(
    DEFAULT_NOTIFICATION_PREFERENCES,
  );
  const [token, setToken] = React.useState(0);

  const refresh = React.useCallback(() => setToken((t) => t + 1), []);

  /**
   * Preferences are held in a ref as well as in state.
   *
   * The socket handler reads them to decide about sound, and it must not
   * re-subscribe every time the operator moves the volume slider — an
   * unsubscribe/subscribe round trip per slider tick.
   */
  const preferencesRef = React.useRef(preferences);
  React.useEffect(() => { preferencesRef.current = preferences; }, [preferences]);

  // ── The feed ─────────────────────────────────────────────────────────────

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      try {
        const res = await fetch(`/api/notifications?limit=${HEAD_PAGE_SIZE}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (cancelled) return;
        if (!res.ok) {
          // 401 means the session went away; the layout guard handles that, and
          // shouting about it here would put a red banner over the redirect.
          if (res.status !== 401) setError('Notifications are unavailable.');
          setLoading(false);
          return;
        }
        const page = await res.json() as {
          notifications: NotificationDto[]; unreadCount: number;
        };
        if (cancelled) return;
        setNotifications(page.notifications);
        setError(null);
        setLoading(false);
      } catch {
        if (!cancelled && !controller.signal.aborted) {
          setError('Notifications are unavailable.');
          setLoading(false);
        }
      }
    }

    void load();
    return () => { cancelled = true; controller.abort(); };
  }, [token]);

  /**
   * The badge, polled separately and more often than the feed is refetched.
   *
   * A count is one index scan; a page is a join and a sort. The bell shows a
   * number on every screen and opens the list only when clicked, so the two are
   * deliberately different requests.
   */
  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function poll() {
      try {
        const res = await fetch('/api/notifications/unread', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (cancelled || !res.ok) return;
        setUnread(await res.json() as UnreadSummary);
      } catch {
        // Silent: a failed badge poll is a stale number for thirty seconds, and
        // the feed's own error state already reports a broken connection.
      }
    }

    void poll();
    const timer = setInterval(() => { void poll(); }, BACKSTOP_POLL_MS);
    return () => { cancelled = true; controller.abort(); clearInterval(timer); };
  }, [token]);

  // ── Preferences ──────────────────────────────────────────────────────────

  React.useEffect(() => {
    let cancelled = false;
    void loadNotificationPreferences().then((result) => {
      if (cancelled || !result.ok || !result.preferences) return;
      setPreferences(result.preferences);
    });
    return () => { cancelled = true; };
  }, []);

  const savePreferences = React.useCallback(
    async (update: Partial<NotificationPreferences>) => {
      const result = await saveNotificationPreferences(update);
      // The STORED state, not the requested one. An operator who tried to mute
      // panic sees the switch snap back rather than believing it took.
      if (result.ok && result.preferences) setPreferences(result.preferences);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    [],
  );

  // ── Live arrivals ────────────────────────────────────────────────────────

  /**
   * One topic: the operator's own.
   *
   * `user:<id>` is refused to everybody but its owner on EVERY delivery, not
   * just at subscribe time (realtime/topics.ts), so there is nothing to get
   * wrong here — a client that asked for somebody else's stream would simply be
   * denied.
   */
  const topics = React.useMemo(() => [`user:${auth.userId}`], [auth.userId]);

  const onEvent = React.useCallback((event: RealtimeEvent) => {
    if (event.type !== 'notification.created') return;
    const { payload } = event;

    const current = preferencesRef.current;

    /**
     * A muted category is not shown as a toast — and is still fetched.
     *
     * Muting is about interruption, not about concealment: the entry lands in
     * the centre either way, and the badge counts it. An operator who muted
     * "units" has said "stop interrupting me about crew changes", not "hide
     * them from me", and a notification the server sent that the client threw
     * away would be a lie the badge then contradicts.
     *
     * `isMuted` returns false for panic regardless of what is stored, so a
     * tampered preference cannot suppress the one that matters.
     */
    const muted = isMuted(payload.type, current);
    const severity = NOTIFICATION_SEVERITIES[payload.severity]
      ?? NOTIFICATION_SEVERITIES.info;

    if (!muted && (payload.severity !== 'critical' || current.criticalToasts)) {
      toast.push({
        tone: severity.tone,
        title: payload.title,
        ...(payload.body === null ? {} : { description: payload.body }),
        // A critical toast stays until dismissed. Everything else clears itself:
        // a console covered in stale toasts is a console where the one that
        // matters is behind the others.
        duration: severity.sticky ? null : 6000,
      });
    }

    /**
     * Sound, if and only if the operator asked for it.
     *
     * `shouldPlaySound` is the shared decision — the type must be audible at
     * all, sound must be enabled, and the critical-only filter must pass. It is
     * off by default, and a muted category makes no noise either.
     */
    if (!muted && shouldPlaySound(payload.type, payload.severity, current)) {
      playAlertTone(payload.severity === 'critical', current.soundVolume);
    }

    // Refetch: the payload is a headline, the list is the record.
    refresh();
  }, [refresh, toast]);

  const onResync = React.useCallback(() => { refresh(); }, [refresh]);

  useRealtime({ topics, onEvent, onResync });

  // ── Read state ───────────────────────────────────────────────────────────

  const markRead = React.useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;

    /**
     * Optimistic locally, authoritative from the server.
     *
     * The row is marked read in place so the list does not jump while the
     * operator is reading it, and the BADGE comes from the response rather than
     * being decremented here — the server is the only thing that knows whether
     * another tab already read it.
     */
    const at = new Date().toISOString();
    setNotifications((prev) => prev.map(
      (n) => (ids.includes(n.id) && n.readAt === null ? { ...n, readAt: at } : n),
    ));

    const result = await markNotificationsRead(ids);
    if (result.ok && result.unread) setUnread(result.unread);
    else refresh();
  }, [refresh]);

  const markAllRead = React.useCallback(async () => {
    const at = new Date().toISOString();
    setNotifications((prev) => prev.map((n) => (n.readAt === null ? { ...n, readAt: at } : n)));

    const result = await markAllNotificationsRead();
    if (result.ok && result.unread) setUnread(result.unread);
    else refresh();
  }, [refresh]);

  const value = React.useMemo<NotificationContextValue>(() => ({
    notifications, unread, loading, error, preferences,
    refresh, markRead, markAllRead, savePreferences,
  }), [
    notifications, unread, loading, error, preferences,
    refresh, markRead, markAllRead, savePreferences,
  ]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

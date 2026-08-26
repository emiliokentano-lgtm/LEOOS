import type { NotificationPreferences } from './notifications';

/**
 * Sound cues.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS SEPARATELY FROM THE NOTIFICATION TONE
 *
 * Sound already existed, driven entirely by NOTIFICATIONS. That covers events
 * that happen elsewhere and are pushed to you, and it cannot cover the thing
 * operators actually asked for first: **the confirmation that your own action
 * landed**. Setting your status produces no notification to you, by design —
 * you are not told about what you just did — so there was nothing for the tone
 * to hang on.
 *
 * So a cue has two sources and one player:
 *
 *   REMOTE   a notification arrives → its type maps to a cue
 *   LOCAL    the screen already knows something happened → it asks for a cue
 *
 * The rule that keeps this honest is that a cue is fired from the SAME PLACE
 * that already updated the screen — never from a second fetch, never from an
 * optimistic guess. A sound that plays for something the screen did not show
 * would be the application asserting something it does not know.
 *
 * SOUND IS STILL NEVER THE MECHANISM. Every cue below annotates information
 * that is already visible without it. It is off by default, it is allowed to
 * fail silently, and nothing checks whether it worked — see
 * docs/architecture/12-notifications.md §5.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type SoundCue =
  | 'panic'
  | 'backup'
  | 'status'
  | 'dispatch'
  | 'message';

/**
 * One note. A tone is a sequence of them.
 *
 * DATA, not code, for the same reason the status catalogue is: adding a cue
 * should be a table entry, not a branch in the player. The player reads these
 * and knows nothing about what any cue means.
 */
export interface SoundNote {
  /** Hertz. */
  frequency: number;
  /** Seconds from the start of the cue. */
  startAt: number;
  /** Seconds. */
  duration: number;
}

export interface SoundCueMeta {
  label: string;
  /** Said on the settings screen, so the operator knows what they are enabling. */
  description: string;
  tone: SoundNote[];
  /**
   * Whether the operator may silence this cue individually.
   *
   * `panic` is false and that is enforced in four places — see
   * `UNMUTABLE_CUES` below.
   */
  mutable: boolean;
  /**
   * Cues at or above this rate are collapsed into one.
   *
   * A busy channel must not turn into a machine gun; an operator who is being
   * shot at by their own notification sound turns it off, and then loses the
   * panic cue with it. Null means never suppressed.
   */
  minGapMs: number | null;
}

/**
 * The catalogue.
 *
 * Each tone is SHAPED to be told apart without looking, which is the whole
 * point of having more than one: rising and repeating for an emergency,
 * a single soft note for a confirmation, a two-note fall for something
 * informational. None of them is longer than a second — a cue that outlasts the
 * glance it accompanies is an annoyance, not a signal.
 */
export const SOUND_CUES: Record<SoundCue, SoundCueMeta> = {
  panic: {
    label: 'Panic',
    description: 'Somebody has raised a panic. Always audible when sound is on.',
    // Rising, repeated, and the longest thing here. It should be unmistakable.
    tone: [
      { frequency: 880, startAt: 0, duration: 0.14 },
      { frequency: 1174, startAt: 0.16, duration: 0.14 },
      { frequency: 880, startAt: 0.34, duration: 0.14 },
      { frequency: 1174, startAt: 0.5, duration: 0.2 },
    ],
    mutable: false,
    // Never suppressed. Two panics in four seconds are two panics.
    minGapMs: null,
  },
  backup: {
    label: 'Backup requested',
    description: 'A colleague in your organization has asked for backup.',
    // Urgent but not panic: two rising notes, no repeat.
    tone: [
      { frequency: 784, startAt: 0, duration: 0.12 },
      { frequency: 1046, startAt: 0.14, duration: 0.18 },
    ],
    mutable: true,
    minGapMs: 3_000,
  },
  status: {
    label: 'Status set',
    description: 'Confirms that your own duty status changed.',
    // A single short note. This one fires often, so it is the quietest shape.
    tone: [{ frequency: 660, startAt: 0, duration: 0.09 }],
    mutable: true,
    minGapMs: 1_000,
  },
  dispatch: {
    label: 'Dispatch',
    description: 'A call was assigned to you, or one you are on changed.',
    tone: [
      { frequency: 587, startAt: 0, duration: 0.1 },
      { frequency: 784, startAt: 0.12, duration: 0.14 },
    ],
    mutable: true,
    minGapMs: 2_000,
  },
  message: {
    label: 'Message',
    description: 'A new chat message in a conversation you are in.',
    // Deliberately the softest and lowest: the most frequent cue must be the
    // least intrusive, or it is the one that gets sound turned off entirely.
    tone: [{ frequency: 523, startAt: 0, duration: 0.08 }],
    mutable: true,
    minGapMs: 4_000,
  },
};

export const SOUND_CUE_KEYS = Object.keys(SOUND_CUES) as SoundCue[];

/**
 * Panic is never silenceable, and this is the first of four places that say so.
 *
 * The others are the API stripping it from any incoming list, the API stripping
 * it again on the way OUT so a hand-edited row cannot silence an operator
 * either, and a DB CHECK. The same shape as `UNMUTABLE_CATEGORIES` for muting a
 * notification, and for the same reason: an operator who has silenced panic is
 * an operator who will not answer one.
 */
export const UNMUTABLE_CUES: SoundCue[] = SOUND_CUE_KEYS.filter(
  (cue) => !SOUND_CUES[cue].mutable,
);

export function canMuteCue(cue: SoundCue): boolean {
  return SOUND_CUES[cue]?.mutable ?? false;
}

export function isKnownCue(value: string): value is SoundCue {
  return Object.prototype.hasOwnProperty.call(SOUND_CUES, value);
}

/**
 * Should this cue make a sound for this operator?
 *
 * ONE function, used by the player to decide and by the tests to assert the
 * policy — the same arrangement `shouldPlaySound` has for notifications, and
 * for the same reason: a policy that exists twice is a policy that will differ
 * once.
 *
 * Note what is NOT a gate here: `soundCriticalOnly`. That preference is about
 * how chatty the NOTIFICATION stream is allowed to be, and applying it to cues
 * would silence the status confirmation for everybody who has the default
 * settings — which is the one cue that was asked for. A cue the operator does
 * not want is silenced by muting that cue.
 */
export function shouldPlayCue(
  cue: string,
  preferences: Pick<NotificationPreferences, 'soundEnabled' | 'mutedCues'>,
): boolean {
  if (!preferences.soundEnabled) return false;
  if (!isKnownCue(cue)) return false;
  if (!canMuteCue(cue)) return true;
  return !preferences.mutedCues.includes(cue);
}

/**
 * The cue a notification type maps to, or null.
 *
 * EVERY ENTRY HERE IS A TYPE THE NOTIFICATION CATALOGUE ALREADY MARKS
 * `audible`. That is not a coincidence to be maintained by hand — the caller
 * gates on `audible` as well — but listing only audible types keeps the map
 * from LOOKING like coverage it does not have. A task is deliberately silent
 * ("a tone for one would train operators to ignore the tones that mean
 * something is happening now"), so there is no task cue at all rather than a
 * cue that can never sound.
 */
const NOTIFICATION_CUES: Record<string, SoundCue> = {
  'panic.triggered': 'panic',
  'incident.critical': 'dispatch',
  'incident.assigned': 'dispatch',
  'field_request.backup': 'backup',
  'field_request.accepted': 'dispatch',
};

/*
 * `message` is absent on purpose. Chat does not raise notifications — it
 * travels on the realtime `message.created` event straight to the open thread
 * (docs/architecture/16-chat.md §1) — so the chat screen fires that cue
 * locally, from the same place it already re-reads the thread. Mapping a
 * notification type that does not exist would be a dead entry that looked like
 * coverage.
 */

export function cueForNotification(type: string): SoundCue | null {
  return NOTIFICATION_CUES[type] ?? null;
}

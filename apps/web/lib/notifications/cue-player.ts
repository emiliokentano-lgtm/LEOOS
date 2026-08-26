import { SOUND_CUES, type SoundCue, type SoundNote } from '@leoos/contracts';

/**
 * The cue player.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SOUND IS AN ADDITION, NEVER THE MECHANISM
 *
 * Everything this can play for is ALREADY visible without it: a toast, a badge
 * on the bell, an entry in the centre, a changed status pill, and for a panic an
 * unfilterable alert bar on the map and the dashboard. The brief is explicit
 * that sound must not be relied on, and the reasons are ordinary — a muted tab,
 * an unplugged headset, a room where sound is not acceptable, or a browser that
 * has not seen a click yet and will refuse to play anything at all.
 *
 * So this file is allowed to fail completely and silently. Every path returns
 * without throwing, and nothing else in the application checks whether it
 * worked.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * SYNTHESISED, NOT SHIPPED. Oscillator notes rather than audio files: no asset
 * in the bundle, no MIME negotiation, no licensing question, and no 404 that
 * turns into silence in production. The cost is that it sounds like what it is —
 * a console cue.
 *
 * THE SHAPES ARE DATA. Every tone comes from `SOUND_CUES` in the contracts
 * package; this file knows how to play a sequence of notes and nothing about
 * what any cue means. Adding a cue is a table entry, not a branch here.
 */

let context: AudioContext | null = null;

/**
 * The browser's autoplay policy is the real constraint here.
 *
 * An AudioContext created before any user gesture starts `suspended`, and
 * playing into it does nothing. This resumes it opportunistically; if the
 * operator has not interacted with the page yet, the resume is refused and the
 * cue is skipped. That is correct behaviour, not a bug to work around — and it
 * is exactly why sound can never be the only channel.
 */
function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context ??= new Ctor();
    if (context.state === 'suspended') void context.resume().catch(() => {});
    return context;
  } catch {
    return null;
  }
}

/**
 * What the settings screen reports, in words.
 *
 * `blocked` is the honest answer for a page the browser has not let make a
 * sound yet, and it is common — an operator who opened the dashboard from a
 * bookmark and has not clicked anything. Saying "sound is on" there would be a
 * green light the application has not earned (engineering rule 45).
 */
export type AudioReadiness = 'ready' | 'blocked' | 'unsupported';

/**
 * Published as a STORE rather than read during render.
 *
 * Two reasons. Reading it would mean creating an AudioContext as a side effect
 * of rendering, which is not a thing a render may do; and the value changes on
 * a user gesture the component cannot see. `useSyncExternalStore` is the shape
 * React has for exactly this, and it keeps the settings line honest without a
 * setState cascade.
 */
let readiness: AudioReadiness = 'blocked';
const listeners = new Set<() => void>();

function computeReadiness(): AudioReadiness {
  if (typeof window === 'undefined') return 'unsupported';
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return 'unsupported';
  const ctx = ensureContext();
  if (ctx === null) return 'unsupported';
  return ctx.state === 'running' ? 'ready' : 'blocked';
}

function refreshReadiness(): void {
  const next = computeReadiness();
  if (next === readiness) return;
  readiness = next;
  for (const listener of listeners) listener();
}

export function getAudioReadiness(): AudioReadiness {
  return readiness;
}

/** The server has no audio, and saying "ready" there would be a lie on first paint. */
export function getServerAudioReadiness(): AudioReadiness {
  return 'blocked';
}

/**
 * Subscribing PRIMES the context.
 *
 * The first subscriber is the settings screen, and an operator who opened it is
 * an operator who has clicked something — so this is the moment the browser is
 * most likely to allow audio. A pointer listener keeps the line current if they
 * had not.
 */
export function subscribeAudioReadiness(onChange: () => void): () => void {
  listeners.add(onChange);
  refreshReadiness();
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', refreshReadiness);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', refreshReadiness);
    }
  };
}

function playNotes(notes: readonly SoundNote[], volume: number): void {
  const ctx = ensureContext();
  if (ctx === null || ctx.state !== 'running') return;

  // 0–100 from the preference, scaled well below unity: a console tone that
  // makes somebody take their headset off is a tone they will turn off.
  const gainValue = Math.min(1, Math.max(0, volume / 100)) * 0.22;
  if (gainValue === 0) return;

  try {
    const now = ctx.currentTime;
    for (const note of notes) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = note.frequency;

      // Ramped rather than switched: a square edge on a gain node is an audible
      // click, and a click on every cue is what makes people mute the tab.
      const start = now + note.startAt;
      const end = start + note.duration;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(gainValue, start + 0.01);
      gain.gain.setValueAtTime(gainValue, Math.max(start + 0.011, end - 0.03));
      gain.gain.linearRampToValueAtTime(0, end);

      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.01);
    }
  } catch {
    // Deliberately swallowed. See the header: sound is never load-bearing.
  }
}

/** Plays one cue's tone. The DECISION to play is `shouldPlayCue`, not this. */
export function playCueTone(cue: SoundCue, volume: number): void {
  const meta = SOUND_CUES[cue];
  // An unknown cue is silence, not a crash: a client meeting a catalogue newer
  // than itself should be quiet, not broken.
  if (!meta) return;
  playNotes(meta.tone, volume);
}

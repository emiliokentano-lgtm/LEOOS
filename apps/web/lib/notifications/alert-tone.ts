/**
 * The alert tone.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SOUND IS AN ADDITION, NEVER THE MECHANISM
 *
 * Every notification this can play for is ALREADY visible without it: a toast,
 * a badge on the bell, an entry in the centre, and for a panic an unfilterable
 * alert bar on the map and the dashboard. The brief is explicit that sound must
 * not be relied on, and the reasons are ordinary — an operator with the tab
 * muted, a headset unplugged, a room where sound is not acceptable, or a browser
 * that has not seen a click yet and will refuse to play anything at all.
 *
 * So this file is allowed to fail completely and silently. Every path returns
 * without throwing, and nothing else in the application checks whether it
 * worked.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * SYNTHESISED, NOT SHIPPED. Two short tones from an oscillator rather than an
 * audio file: it adds no asset to the bundle, no MIME negotiation and no
 * licensing question, and it cannot be a 404 that turns into silence in
 * production. The cost is that it sounds like what it is — a console alert.
 */

let context: AudioContext | null = null;

/**
 * The browser's autoplay policy is the real constraint here.
 *
 * An AudioContext created before any user gesture starts `suspended`, and
 * playing into it does nothing. This resumes it opportunistically; if the
 * operator has not interacted with the page yet, the resume is refused and the
 * tone is skipped. That is correct behaviour, not a bug to work around — and it
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

interface Beep {
  frequency: number;
  startAt: number;
  duration: number;
}

/**
 * Two distinct shapes, so an operator can tell them apart without looking.
 *
 * A critical alert is a rising two-tone that repeats; anything else is a single
 * soft note. This is the only place the difference exists — the decision about
 * WHETHER to play is `shouldPlaySound` in the contracts package, shared with the
 * server-side tests.
 */
const CRITICAL: Beep[] = [
  { frequency: 880, startAt: 0, duration: 0.14 },
  { frequency: 1174, startAt: 0.16, duration: 0.14 },
  { frequency: 880, startAt: 0.34, duration: 0.14 },
  { frequency: 1174, startAt: 0.5, duration: 0.2 },
];

const ROUTINE: Beep[] = [
  { frequency: 660, startAt: 0, duration: 0.12 },
];

export function playAlertTone(critical: boolean, volume: number): void {
  const ctx = ensureContext();
  if (ctx === null || ctx.state !== 'running') return;

  // 0–100 from the preference, scaled well below unity: a console tone that
  // makes somebody take their headset off is a tone they will turn off.
  const gainValue = Math.min(1, Math.max(0, volume / 100)) * 0.22;
  if (gainValue === 0) return;

  try {
    const now = ctx.currentTime;
    for (const beep of critical ? CRITICAL : ROUTINE) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = beep.frequency;

      // Ramped rather than switched: a square edge on a gain node is an audible
      // click, and a click on every alert is what makes people mute the tab.
      const start = now + beep.startAt;
      const end = start + beep.duration;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(gainValue, start + 0.01);
      gain.gain.setValueAtTime(gainValue, end - 0.03);
      gain.gain.linearRampToValueAtTime(0, end);

      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.01);
    }
  } catch {
    // Deliberately swallowed. See the header: sound is never load-bearing.
  }
}

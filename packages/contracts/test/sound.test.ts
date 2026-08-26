import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_PREFERENCES, NOTIFICATION_TYPES, SOUND_CUES, SOUND_CUE_KEYS,
  UNMUTABLE_CUES, canMuteCue, cueForNotification, isKnownCue, notificationTypeMeta,
  shouldPlayCue,
  type NotificationType, type SoundCue,
} from '../src/index';

/**
 * The sound-cue policy.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THESE TESTS ARE ACTUALLY DEFENDING
 *
 * Sound is the one feature in this product that an operator can turn off, and
 * the failure that matters is the reverse of the usual one: not "it made a
 * noise it should not have" but "it went quiet for the one thing you needed to
 * hear". Every test below is a version of that.
 * ────────────────────────────────────────────────────────────────────────────
 */

const on = { ...DEFAULT_NOTIFICATION_PREFERENCES, soundEnabled: true };

describe('the master switch', () => {
  it('is OFF by default, panic included', () => {
    // An application that makes noise on first use gets muted at the operating
    // system, and then the panic cue is muted with it.
    expect(DEFAULT_NOTIFICATION_PREFERENCES.soundEnabled).toBe(false);
    for (const cue of SOUND_CUE_KEYS) {
      expect(shouldPlayCue(cue, DEFAULT_NOTIFICATION_PREFERENCES)).toBe(false);
    }
  });

  it('silences everything when off, whatever the mute list says', () => {
    const off = { ...DEFAULT_NOTIFICATION_PREFERENCES, soundEnabled: false, mutedCues: [] };
    expect(shouldPlayCue('panic', off)).toBe(false);
  });

  it('plays every cue by default once sound is on', () => {
    // Nothing is silenced out of the box: an operator who turned sound on gets
    // the cues, and then silences the ones they do not want.
    for (const cue of SOUND_CUE_KEYS) {
      expect(shouldPlayCue(cue, on)).toBe(true);
    }
  });
});

describe('panic cannot be silenced', () => {
  it('is the only unmutable cue, and says so in the catalogue', () => {
    expect(UNMUTABLE_CUES).toEqual(['panic']);
    expect(canMuteCue('panic')).toBe(false);
    expect(SOUND_CUES.panic.mutable).toBe(false);
  });

  it('plays even when the stored list claims it is muted', () => {
    /**
     * The row should never contain this — the API strips it both ways and a DB
     * CHECK refuses it — but a client that received one anyway must play the
     * panic, not swallow it. Failing OPEN is the correct direction for exactly
     * this one decision.
     */
    const tampered = { ...on, mutedCues: ['panic', 'message'] };
    expect(shouldPlayCue('panic', tampered)).toBe(true);
    expect(shouldPlayCue('message', tampered)).toBe(false);
  });

  it('is never suppressed by the rate limiter', () => {
    // Two panics four seconds apart are two panics, and that is precisely when
    // you must hear both.
    expect(SOUND_CUES.panic.minGapMs).toBeNull();
    for (const cue of SOUND_CUE_KEYS.filter((key) => key !== 'panic')) {
      expect(SOUND_CUES[cue].minGapMs).toBeGreaterThan(0);
    }
  });
});

describe('silencing one cue', () => {
  it('takes away that cue and no other', () => {
    const quiet = { ...on, mutedCues: ['message'] };
    expect(shouldPlayCue('message', quiet)).toBe(false);
    expect(shouldPlayCue('status', quiet)).toBe(true);
    expect(shouldPlayCue('backup', quiet)).toBe(true);
  });

  it('ignores a cue this build does not know', () => {
    // A client meeting a catalogue newer than itself is silent, not broken.
    expect(shouldPlayCue('teleport', on)).toBe(false);
    expect(isKnownCue('teleport')).toBe(false);
  });
});

describe('the notification mapping', () => {
  it('only maps types the notification catalogue already marks audible', () => {
    /**
     * THE GATES COMPOSE, THEY DO NOT REPLACE ONE ANOTHER.
     *
     * A type the catalogue marks silent must stay silent however its cue is
     * configured — otherwise adding cues would have quietly overturned the
     * decision that "a tone for a task would train operators to ignore the
     * tones that mean something is happening now".
     */
    for (const type of Object.keys(NOTIFICATION_TYPES) as NotificationType[]) {
      const cue = cueForNotification(type);
      if (cue === null) continue;
      expect(
        notificationTypeMeta(type).audible,
        `${type} maps to the "${cue}" cue but the catalogue marks it silent`,
      ).toBe(true);
    }
  });

  it('gives panic its own cue and nothing else', () => {
    expect(cueForNotification('panic.triggered')).toBe('panic');
    const others = (Object.keys(NOTIFICATION_TYPES) as NotificationType[])
      .filter((type) => type !== 'panic.triggered')
      .map(cueForNotification);
    expect(others).not.toContain('panic');
  });

  it('is silent about a type it does not know', () => {
    expect(cueForNotification('weather.storm')).toBeNull();
  });

  it('has no cue for a task, deliberately', () => {
    // The catalogue calls a task silent; there is no task cue at all rather
    // than one that could never sound.
    expect(cueForNotification('task.assigned')).toBeNull();
    expect(SOUND_CUE_KEYS).not.toContain('task' as SoundCue);
  });
});

describe('the catalogue itself', () => {
  it('gives every cue a label, a description and a tone', () => {
    // The settings screen renders these directly; a cue with no description is
    // a switch an operator cannot make sense of.
    for (const cue of SOUND_CUE_KEYS) {
      const meta = SOUND_CUES[cue];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
      expect(meta.tone.length).toBeGreaterThan(0);
    }
  });

  it('keeps every cue under a second', () => {
    // A cue that outlasts the glance it accompanies is an annoyance, and an
    // annoyance is what gets sound turned off.
    for (const cue of SOUND_CUE_KEYS) {
      const end = Math.max(...SOUND_CUES[cue].tone.map((n) => n.startAt + n.duration));
      expect(end, `${cue} runs ${end}s`).toBeLessThanOrEqual(1);
    }
  });

  it('makes panic the longest cue', () => {
    // Told apart without looking: the emergency is the one that keeps going.
    const lengths = SOUND_CUE_KEYS.map((cue) => ({
      cue,
      end: Math.max(...SOUND_CUES[cue].tone.map((n) => n.startAt + n.duration)),
    }));
    const longest = lengths.reduce((a, b) => (a.end >= b.end ? a : b));
    expect(longest.cue).toBe('panic');
  });
});

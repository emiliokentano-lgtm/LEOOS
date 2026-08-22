/**
 * Makes an arbitrary stored colour readable as text on a dark surface.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * An organization's colour is DATA — `organization.color`, chosen by whoever
 * set the department up, for a badge or a map marker. It was being passed
 * straight into `color:` on 9px text, and the audit caught two of the six
 * seeded organizations failing AA that way: FIB's violet at 4.27:1, and a
 * created department's blue at 3.98:1.
 *
 * The colour cannot simply be constrained at the source. It is the
 * organization's identity, it is used as a FILL as well as a text colour, and
 * an administrator picking their department's real colour should not be told
 * it is invalid because of a contrast rule that only applies to one of its
 * uses.
 *
 * So the fill keeps the stored colour and the TEXT gets a version of it
 * lightened just far enough to be read — same hue, same identity, legible. A
 * colour that already passes is returned untouched, so nothing changes for the
 * organizations whose colours were fine.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** The darkest surface a chip is drawn on. Text must clear AA against it. */
const DEFAULT_BACKGROUND = '#171c27';

interface Rgb { r: number; g: number; b: number }

function parse(colour: string): Rgb | null {
  const hex = colour.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return {
      r: parseInt(hex[0]! + hex[0]!, 16),
      g: parseInt(hex[1]! + hex[1]!, 16),
      b: parseInt(hex[2]! + hex[2]!, 16),
    };
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(colour.trim());
  if (rgb) {
    const parts = rgb[1]!.split(',').map((p) => parseFloat(p.trim()));
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      return { r: parts[0]!, g: parts[1]!, b: parts[2]! };
    }
  }
  return null;
}

const toHex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

function luminance({ r, g, b }: Rgb): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const ca = parse(a);
  const cb = parse(b);
  if (!ca || !cb) return 21;
  const la = luminance(ca);
  const lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The same colour, lightened toward white only as far as `target` requires.
 *
 * Returns the input unchanged when it already passes, and gives up at white —
 * which cannot fail against any of this product's surfaces, so there is no case
 * where this returns something unreadable.
 */
export function readableOn(
  colour: string,
  background: string = DEFAULT_BACKGROUND,
  target = 4.5,
): string {
  const base = parse(colour);
  if (!base) return 'currentColor';
  if (contrastRatio(colour, background) >= target) return colour;

  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const candidate: Rgb = {
      r: base.r + (255 - base.r) * t,
      g: base.g + (255 - base.g) * t,
      b: base.b + (255 - base.b) * t,
    };
    if (contrastRatio(toHex(candidate), background) >= target) return toHex(candidate);
  }
  return '#ffffff';
}

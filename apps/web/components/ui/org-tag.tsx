import { cn } from '@/lib/utils';
import { readableOn } from '@/lib/readable-colour';

/**
 * An organization's short name, in the organization's colour.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE COMPONENT, BECAUSE IT WAS SEVEN COPIES
 *
 * `style={{ borderColor: org.color, color: org.color }}` appeared inline in the
 * map details panel, the map unit list, the panic locator, the dispatch unit
 * board, the incident detail, the panic banner and the admin user detail — each
 * with its own font size and radius. That is the drift this component exists to
 * stop, and it is also why the contrast bug appeared on two screens at once
 * rather than one.
 *
 * THE BORDER KEEPS THE ORGANIZATION'S ACTUAL COLOUR. The TEXT uses a version of
 * it lightened only as far as legibility requires — see `readableOn`. Two of
 * the seeded organizations' colours failed AA as 9px text, and the fix cannot
 * be "pick a different colour": the colour is the department's identity and is
 * also used as a fill, where it is fine.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function OrgTag({
  shortName,
  color,
  name,
  size = 'sm',
  className,
}: {
  shortName: string;
  color: string;
  /**
   * The full name, shown on hover in place of the abbreviation.
   *
   * Optional because the MAP's organization ref deliberately carries only what a
   * marker needs — id, key, short name, colour — and widening that payload for a
   * tooltip would put a string on every unit in every position frame. Where it
   * is absent the short name is the title, which is what it was before.
   */
  name?: string;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-[2px] border font-medium whitespace-nowrap',
        size === 'xs' ? 'px-1 text-[10px] leading-4' : 'px-1 text-2xs leading-4',
        className,
      )}
      style={{ borderColor: color, color: readableOn(color) }}
      // "FIB" is read out letter by letter and means nothing to somebody who
      // does not already know the abbreviation.
      title={name ?? shortName}
    >
      {shortName}
    </span>
  );
}

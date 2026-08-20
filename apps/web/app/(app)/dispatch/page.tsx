import type { Metadata } from 'next';
import { requireSession } from '@/lib/session';
import { fetchDispatchBoard } from '@/lib/dispatch';
import { DispatchView } from './dispatch-view';

export const metadata: Metadata = { title: 'Dispatch' };

/**
 * The Leitstelle.
 *
 * The first board is fetched server-side so the screen paints with the shift
 * already on it rather than a spinner that turns into it. Everything after that
 * arrives through the client data source.
 *
 * What is on the board is decided entirely by the API. This page does not
 * filter and does not know what was withheld.
 */
export default async function DispatchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const board = await fetchDispatchBoard();
  const params = await searchParams;

  /**
   * `?unit=` — a unit arrived at from somewhere else, the map's "View unit"
   * today. It focuses a row that the API already decided to send; it does not
   * widen the board by one character, so an id belonging to another
   * organization simply matches nothing.
   */
  const unit = params.unit;

  return (
    <DispatchView
      initialBoard={board}
      focusUnitId={typeof unit === 'string' && unit !== '' ? unit : null}
    />
  );
}

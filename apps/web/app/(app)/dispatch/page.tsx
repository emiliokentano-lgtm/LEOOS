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
export default async function DispatchPage() {
  await requireSession();
  const board = await fetchDispatchBoard();

  return <DispatchView initialBoard={board} />;
}

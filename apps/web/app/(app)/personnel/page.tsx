import type { Metadata } from 'next';
import { requireSession } from '@/lib/session';
import { PersonnelView } from './personnel-view';

export const metadata: Metadata = { title: 'Personnel' };

export default async function PersonnelPage() {
  const session = await requireSession();
  return <PersonnelView actorLevel={session.hierarchyLevel} actorName={session.displayName} />;
}

import type { Metadata } from 'next';
import { requireSession } from '@/lib/session';
import { RolesView } from './roles-view';

export const metadata: Metadata = { title: 'Roles' };

export default async function RolesPage() {
  const session = await requireSession();
  return <RolesView actorLevel={session.hierarchyLevel} />;
}

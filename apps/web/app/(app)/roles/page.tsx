import type { Metadata } from 'next';
import { getSession } from '@/lib/session';
import { RolesView } from './roles-view';

export const metadata: Metadata = { title: 'Roles' };

export default async function RolesPage() {
  const session = await getSession();
  return <RolesView actorLevel={session.hierarchyLevel} />;
}

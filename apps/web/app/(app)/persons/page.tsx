import type { Metadata } from 'next';
import { PersonsView } from './persons-view';

export const metadata: Metadata = { title: 'Persons' };

export default function PersonsPage() {
  return <PersonsView />;
}

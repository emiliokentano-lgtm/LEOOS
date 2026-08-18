import type { Metadata } from 'next';
import { DesignView } from './design-view';

export const metadata: Metadata = { title: 'Design System' };

export default function DesignPage() {
  return <DesignView />;
}

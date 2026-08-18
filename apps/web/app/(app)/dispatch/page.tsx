import type { Metadata } from 'next';
import { DispatchView } from './dispatch-view';

export const metadata: Metadata = { title: 'Dispatch' };

export default function DispatchPage() {
  return <DispatchView />;
}

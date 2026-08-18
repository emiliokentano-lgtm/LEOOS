import type { Metadata } from 'next';
import { VehiclesView } from './vehicles-view';

export const metadata: Metadata = { title: 'Vehicles' };

export default function VehiclesPage() {
  return <VehiclesView />;
}

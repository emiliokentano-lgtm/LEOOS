import type { Metadata } from 'next';
import { MapView } from './map-view';

export const metadata: Metadata = { title: 'Live Map' };

export default function MapPage() {
  return <MapView />;
}

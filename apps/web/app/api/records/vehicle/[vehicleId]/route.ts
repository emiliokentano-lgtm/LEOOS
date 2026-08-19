import { NextResponse } from 'next/server';
import { fetchVehicleProfile } from '@/lib/vehicles';

/** Vehicle profile, for the detail drawer. See the person route for the hop. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ vehicleId: string }> },
): Promise<NextResponse> {
  const { vehicleId } = await params;
  const profile = await fetchVehicleProfile(vehicleId);
  if (!profile) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  return NextResponse.json(profile, { headers: { 'cache-control': 'no-store' } });
}

import type { Metadata } from 'next';
import { AuditView } from './audit-view';

export const metadata: Metadata = { title: 'Audit Logs' };

export default function AuditPage() {
  return <AuditView />;
}

import type { Metadata } from 'next';
import { requireAdminCapabilities } from '../admin/guard';
import { fetchAuditPage, fetchAuditVocabulary } from '@/lib/admin';
import { AuditView } from './audit-view';
import type { AuditOutcome, AuditSeverity } from '@leoos/contracts';

export const metadata: Metadata = { title: 'Audit Logs' };

/**
 * The audit log.
 *
 * Every filter is applied SERVER-SIDE, over the whole table. Filtering a page
 * that happened to load would make "show me every refused privilege escalation"
 * mean "show me the refusals among the last fifty rows" — which reads as a
 * quiet week rather than as a filter that did not do what it said.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminCapabilities('canViewAuditLog');
  const params = await searchParams;

  const one = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' && value ? value : undefined;
  };

  const query = {
    search: one('search'),
    actorUserId: one('actor'),
    actionPrefix: one('ns'),
    action: one('action'),
    organizationId: one('org'),
    entityId: one('target'),
    entityType: one('targetType'),
    outcome: one('outcome') as AuditOutcome | undefined,
    severity: one('severity') as AuditSeverity | undefined,
    from: one('from'),
    to: one('to'),
    cursor: one('cursor'),
    limit: 50,
  };

  const [page, vocabulary] = await Promise.all([
    fetchAuditPage(query),
    fetchAuditVocabulary(),
  ]);

  return (
    <AuditView
      page={page}
      organizations={vocabulary.organizations}
      actions={vocabulary.actions}
      filters={{
        search: query.search ?? '',
        actor: query.actorUserId ?? '',
        ns: query.actionPrefix ?? '',
        action: query.action ?? '',
        org: query.organizationId ?? '',
        target: query.entityId ?? '',
        outcome: query.outcome ?? '',
        severity: query.severity ?? '',
        from: query.from ?? '',
        to: query.to ?? '',
        cursor: query.cursor ?? '',
      }}
    />
  );
}

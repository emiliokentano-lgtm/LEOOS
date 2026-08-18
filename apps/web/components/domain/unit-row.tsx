'use client';

import { cn, timeAgo } from '@/lib/utils';
import { DutyStatusBadge, OrgBadge } from '@/components/ui';
import { Icon } from '@/components/icon';
import { UNIT_TYPES } from '@leoos/contracts';
import type { MockUnit } from '@/mocks/operations';
import { MOCK_NOW } from '@/mocks/operations';
import { mockOrg } from '@/mocks/organizations';

/** One unit on a unit board. Callsign is mono — it is read aloud over radio. */
export function UnitRow({
  unit, selected, onSelect, showOrg = true,
}: {
  unit: MockUnit;
  selected?: boolean;
  onSelect?: (unit: MockUnit) => void;
  showOrg?: boolean;
}) {
  const org = mockOrg(unit.organizationId);
  const type = UNIT_TYPES[unit.unitType];
  const stale = MOCK_NOW.getTime() - unit.lastUpdate.getTime() > 15_000;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(unit)}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 border-b border-border-subtle px-3 py-1.5 text-left',
        'transition-colors duration-(--duration-fast)',
        selected ? 'bg-active' : 'hover:bg-hover',
        stale && 'opacity-60',
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-text-tertiary">
        <Icon name={type.icon} className="size-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs font-semibold text-text-primary">{unit.callsign}</span>
          {showOrg ? <OrgBadge shortName={org.shortName} color={org.color} size="sm" /> : null}
        </div>
        <p className="truncate text-2xs text-text-tertiary">
          {unit.memberNames.join(', ')}
          {unit.vehicle ? ` · ${unit.vehicle}` : ''}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <DutyStatusBadge status={unit.status} display="short" size="sm" />
        <span className="font-mono text-2xs text-text-tertiary">
          {timeAgo(unit.lastUpdate, MOCK_NOW)}
        </span>
      </div>
    </button>
  );
}

'use client';

import * as React from 'react';
import { Check, Plus, Undo2 } from 'lucide-react';
import { compareTasks, taskState, type TaskDto, type TaskListDto } from '@leoos/contracts';
import {
  Badge, Button, EmptyState, Panel, PanelHeader, Alert, useToast,
} from '@/components/ui';
import { cn, formatRelative } from '@/lib/utils';
import { completeTask } from '@/lib/task-actions';

/**
 * The caller's own tasks.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FOUR STATES, NOT TWO
 *
 * Loading, failed, empty and loaded are all different, and the dashboard's
 * governing rule is that they must LOOK different. An empty list rendered
 * because a request timed out is a lie in the safe-looking direction — the
 * operator concludes there is nothing to do.
 *
 * `null` means the load failed and says so; `{ tasks: [] }` means there is
 * genuinely nothing.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ORDERING IS THE FEATURE. Overdue first, then due-soon, then the rest, each
 * band by priority and then by deadline. An operator glancing at this panel
 * must see what is already late at the top without sorting or filtering, and
 * `compareTasks` is shared with the API's own ordering so the two agree.
 */
export function TaskPanel({
  data,
  onChanged,
}: {
  /** Null when the load failed. Empty tasks means genuinely none. */
  data: TaskListDto | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [pending, setPending] = React.useState<string | null>(null);

  /**
   * The clock ticks once a minute, not once a second.
   *
   * A deadline is measured in hours; a per-second tick would re-render this
   * panel 3,600 times an hour to move a label from "in 2 hours" to "in 2
   * hours". The field-request strip ticks per second because it counts down
   * from three minutes — different data, different clock.
   */
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const sorted = React.useMemo(
    () => (data === null ? [] : [...data.tasks].sort((a, b) => compareTasks(a, b, now))),
    [data, now],
  );

  async function toggle(task: TaskDto) {
    setPending(task.id);
    try {
      const result = await completeTask(task.id, task.completedAt === null);
      if (!result.ok) {
        toast.push({ title: result.error ?? 'That could not be saved.', tone: 'danger' });
        return;
      }
      onChanged();
    } finally {
      setPending(null);
    }
  }

  return (
    <Panel flush className="min-h-0">
      <PanelHeader
        title="My tasks"
        actions={
          data === null ? null : (
            <div className="flex items-center gap-1.5">
              {/* Overdue is called out in WORDS as well as colour — status must
                  never be communicated by colour alone. */}
              {data.counts.overdue > 0 ? (
                <Badge variant="danger" mono>{data.counts.overdue} overdue</Badge>
              ) : null}
              {data.counts.dueSoon > 0 ? (
                <Badge variant="warning" mono>{data.counts.dueSoon} due soon</Badge>
              ) : null}
              <Badge variant="neutral" mono>{data.counts.open}</Badge>
            </div>
          )
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        {data === null ? (
          /* FAILED, and it says so. Not an empty list — an operator who is
             shown "no tasks" because a request timed out stops looking. */
          <div className="p-3">
            <Alert tone="warning" title="Tasks unavailable">
              This list could not be loaded. It is not necessarily empty.
            </Alert>
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState
            title="Nothing assigned"
            description="Work assigned to you appears here."
            icon={<Plus className="size-5" aria-hidden />}
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {sorted.map((task) => {
              const state = taskState(task, now);
              const done = task.completedAt !== null;

              return (
                <li
                  key={task.id}
                  className={cn(
                    'flex items-start gap-2.5 px-3 py-2',
                    state === 'overdue' && 'border-l-2 border-l-danger bg-danger/5 pl-[10px]',
                    state === 'due_soon' && 'border-l-2 border-l-warning pl-[10px]',
                    done && 'opacity-60',
                  )}
                >
                  <Button
                    size="xs"
                    variant={done ? 'ghost' : 'secondary'}
                    disabled={pending === task.id}
                    onClick={() => void toggle(task)}
                    aria-label={done ? `Re-open ${task.title}` : `Complete ${task.title}`}
                  >
                    {done ? <Undo2 aria-hidden /> : <Check aria-hidden />}
                  </Button>

                  <div className="min-w-0 flex-1">
                    <p className={cn(
                      'text-xs text-text-primary',
                      done && 'line-through',
                    )}
                    >
                      {task.title}
                    </p>

                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5
                      text-2xs text-text-tertiary"
                    >
                      <span
                        className="font-medium"
                        style={{ color: `var(${task.priority.colorToken})` }}
                      >
                        {task.priority.label}
                      </span>

                      {/* WHO asked, and WHEN. Both are on screen because "who
                          told me to do this" is the first question somebody
                          asks about a task they did not expect. */}
                      {task.createdBy ? (
                        <span>
                          from {task.createdBy.callsign
                            ? `${task.createdBy.callsign} · ` : ''}
                          {task.createdBy.displayName}
                        </span>
                      ) : null}

                      <span>set {formatRelative(task.createdAt, now)}</span>

                      {task.dueAt ? (
                        <span className={cn(
                          state === 'overdue' && 'font-semibold text-danger',
                          state === 'due_soon' && 'font-semibold text-warning',
                        )}
                        >
                          {state === 'overdue' ? 'overdue — was due ' : 'due '}
                          {formatRelative(task.dueAt, now)}
                        </span>
                      ) : (
                        <span>no deadline</span>
                      )}
                    </p>

                    {task.detail ? (
                      <p className="mt-1 text-2xs text-text-secondary">{task.detail}</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}

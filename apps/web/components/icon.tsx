import * as Icons from 'lucide-react';

/**
 * Renders a lucide icon by name.
 *
 * Needed because navigation, statuses and unit types are DATA — they name their
 * icon as a string so the catalogue stays serialisable and a status added to the
 * database can carry its own icon (engineering rules 5-7).
 */
export function Icon({ name, className }: { name: string; className?: string }) {
  const Cmp = (Icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[name];
  if (!Cmp) return null;
  return <Cmp className={className} aria-hidden />;
}

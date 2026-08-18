'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CornerDownLeft, Search } from 'lucide-react';
import type { NavSection } from '@/lib/navigation';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';
import { Modal } from '@/components/ui';

/**
 * Ctrl+K command palette.
 *
 * Dispatchers work by keyboard. This reaches every screen the user can access —
 * and only those, because it is fed the same server-filtered navigation the
 * sidebar renders.
 */

interface CommandPaletteContextValue {
  open: () => void;
  close: () => void;
  isOpen: boolean;
}

const CommandPaletteContext = React.createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = React.useContext(CommandPaletteContext);
  if (!ctx) throw new Error('useCommandPalette must be used inside <CommandPaletteProvider>');
  return ctx;
}

interface Command {
  id: string;
  label: string;
  icon: string;
  href: string;
  group: string;
}

export function CommandPaletteProvider({
  sections, children,
}: {
  sections: NavSection[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);

  const commands = React.useMemo<Command[]>(
    () =>
      sections.flatMap((section) =>
        section.items.map((item) => ({
          id: item.href,
          label: item.label,
          icon: item.icon,
          href: item.href,
          group: section.label ?? 'Operations',
        })),
      ),
    [sections],
  );

  const results = React.useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }, [commands, query]);

  const open = React.useCallback(() => { setQuery(''); setActiveIndex(0); setIsOpen(true); }, []);
  const close = React.useCallback(() => setIsOpen(false), []);

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function runCommand(cmd: Command | undefined) {
    if (!cmd) return;
    setIsOpen(false);
    router.push(cmd.href as never);
  }

  const value = React.useMemo(() => ({ open, close, isOpen }), [open, close, isOpen]);

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <Modal open={isOpen} onOpenChange={setIsOpen} title="Command palette" size="md">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 rounded-xs border border-border bg-raised px-2.5">
            <Search className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.min(i + 1, results.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  runCommand(results[activeIndex]);
                }
              }}
              placeholder="Jump to a screen…"
              aria-label="Command search"
              className="h-9 w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </div>

          <ul className="max-h-[320px] overflow-auto" role="listbox" aria-label="Commands">
            {results.length === 0 ? (
              <li className="px-2 py-6 text-center text-xs text-text-tertiary">
                No matching screen
              </li>
            ) : (
              results.map((cmd, i) => (
                <li key={cmd.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === activeIndex}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => runCommand(cmd)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-xs px-2 py-2 text-left text-sm',
                      i === activeIndex ? 'bg-hover text-text-primary' : 'text-text-secondary',
                    )}
                  >
                    <Icon name={cmd.icon} className="size-4 shrink-0 text-text-tertiary" />
                    <span>{cmd.label}</span>
                    <span className="ml-auto text-2xs text-text-tertiary">{cmd.group}</span>
                    {i === activeIndex ? (
                      <CornerDownLeft className="size-3 shrink-0 text-text-tertiary" aria-hidden />
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      </Modal>
    </CommandPaletteContext.Provider>
  );
}

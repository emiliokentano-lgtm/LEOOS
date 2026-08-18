import { ShieldCheck } from 'lucide-react';
import { TooltipProvider } from '@/components/ui';

/**
 * Authentication shell.
 *
 * Same design language as the application — same surfaces, same typography, same
 * restraint. Deliberately not a marketing page: this is the front door of an
 * operational system, and it should look like one.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col bg-base">
        {/* A quiet identity strip rather than a hero banner. */}
        <header className="flex h-(--spacing-topbar) shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-4">
          <ShieldCheck className="size-4 text-accent" aria-hidden />
          <span className="text-sm font-semibold tracking-tight text-text-primary">LEOOS</span>
          <span className="text-xs text-text-tertiary">
            Law Enforcement &amp; Emergency Operations System
          </span>
        </header>

        <main className="flex flex-1 items-center justify-center px-4 py-10">
          <div className="w-full max-w-[380px]">{children}</div>
        </main>

        <footer className="flex h-(--spacing-statusbar) shrink-0 items-center justify-between border-t border-border-subtle bg-surface px-4 text-2xs text-text-tertiary">
          <span>Authorized personnel only. All access is logged.</span>
          <span className="font-mono">v0.1.0-design</span>
        </footer>
      </div>
    </TooltipProvider>
  );
}

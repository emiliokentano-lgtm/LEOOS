import { TooltipProvider } from '@/components/ui';

/**
 * Layout for authenticated screens that exist OUTSIDE an organization context.
 *
 * Deliberately its own route group rather than part of `(app)`: the app layout
 * redirects member-less users to `/no-organization`, so a page living under that
 * layout would redirect to itself and render nothing. Separating the groups makes
 * the loop impossible rather than merely unlikely.
 */
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <div className="min-h-dvh bg-base">{children}</div>
    </TooltipProvider>
  );
}

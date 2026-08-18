import Link from 'next/link';
import { Button } from '@/components/ui';

export default function NotFound() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-base px-6 text-center">
      <p className="font-mono text-3xl font-semibold text-text-disabled">404</p>
      <h1 className="text-lg font-semibold text-text-primary">Page not found</h1>
      <p className="max-w-sm text-sm text-text-secondary">
        This screen does not exist, or you do not have access to it.
      </p>
      <Button asChild variant="secondary" size="sm" className="mt-2">
        <Link href="/dashboard">Return to dashboard</Link>
      </Button>
    </div>
  );
}

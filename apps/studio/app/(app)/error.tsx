'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { copy } from '@/lib/copy';

/**
 * Shown when a page in the signed-in area cannot load (the Gateway or n8n is down, say). Plain words and a way
 * forward, never the error itself: the server has already logged it.
 */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    // Only the digest (a hash) reaches the browser in production: enough to find the server log line.
    const digest = typeof error === 'object' && error !== null && 'digest' in error ? String((error as { digest: unknown }).digest) : undefined;
    console.error('page failed to load', digest ?? '');
  }, [error]);

  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <h1 className="text-xl font-semibold">{copy.errors.loadFailedTitle}</h1>
      <p className="text-sm text-muted-foreground">{copy.errors.loadFailed}</p>
      <div className="mt-2 flex gap-2">
        <Button onClick={() => retry()}>{copy.errors.retry}</Button>
        <Button asChild variant="outline">
          <Link href="/agents">{copy.notFound.back}</Link>
        </Button>
      </div>
    </div>
  );
}

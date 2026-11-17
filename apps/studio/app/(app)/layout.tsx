import { Suspense } from 'react';
import { CreditAmount } from '@/components/credit-amount';
import { TopBar } from '@/components/top-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { isPreview } from '@/lib/env';
import { requireSession, toViewer } from '@/lib/session';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* The credit is slow to read (Gateway, then the chain), so it fills in after the page has drawn. */}
      <TopBar
        viewer={toViewer(session)}
        credit={
          <Suspense fallback={<Skeleton className="h-4 w-12" />}>
            <CreditAmount session={session} />
          </Suspense>
        }
        preview={isPreview()}
      />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-8 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}

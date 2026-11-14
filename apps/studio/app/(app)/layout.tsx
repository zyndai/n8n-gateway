import { TopBar } from '@/components/top-bar';
import { totalCredit } from '@/lib/data';
import { isPreview } from '@/lib/env';
import { requireSession, toViewer } from '@/lib/session';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const credit = await totalCredit(session);
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <TopBar viewer={toViewer(session)} creditUsd={credit} preview={isPreview()} />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-8 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}

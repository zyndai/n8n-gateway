import Link from 'next/link';
import type { ReactNode } from 'react';
import { AccountMenu } from '@/components/account-menu';
import { Logo } from '@/components/logo';
import { copy } from '@/lib/copy';
import type { Viewer } from '@/lib/types';

export function TopBar({ viewer, credit, preview }: { viewer: Viewer; credit: ReactNode; preview: boolean }) {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
      {preview ? <div className="bg-secondary py-1 text-center text-xs text-muted-foreground">{copy.preview.banner}</div> : null}
      <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Logo />
          <nav aria-label="Main">
            <Link href="/agents" className="rounded-md px-2.5 py-1.5 text-sm font-medium text-foreground hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
              {copy.nav.agents}
            </Link>
          </nav>
        </div>
        <AccountMenu viewer={viewer} credit={credit} />
      </div>
    </header>
  );
}

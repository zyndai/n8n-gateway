'use client';

import { ChevronDown, LogOut } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { copy } from '@/lib/copy';
import { formatUsd } from '@/lib/format';
import type { Viewer } from '@/lib/types';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [parts[0]];
  return letters.map((p) => p?.[0] ?? '').join('').toUpperCase() || '?';
}

export function AccountMenu({ viewer, creditUsd }: { viewer: Viewer; creditUsd: string | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={copy.nav.account}
        className="flex items-center gap-2 rounded-full py-1 pr-2 pl-1 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Avatar className="size-8">
          <AvatarFallback className="bg-secondary text-xs font-medium">{initials(viewer.name)}</AvatarFallback>
        </Avatar>
        <span className="hidden max-w-40 truncate font-medium sm:inline">{viewer.name}</span>
        <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <p className="text-xs text-muted-foreground">{copy.account.signedInAs}</p>
          <p className="truncate text-sm font-medium">{viewer.name}</p>
          {viewer.email ? <p className="truncate text-xs text-muted-foreground">{viewer.email}</p> : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="flex items-center justify-between px-2 py-1.5 text-sm">
          <span className="text-muted-foreground">{copy.account.totalCredit}</span>
          <span className="font-medium tabular-nums" title={creditUsd === null ? copy.account.unknownCredit : undefined}>
            {formatUsd(creditUsd)}
          </span>
        </div>
        <DropdownMenuSeparator />
        <form action="/auth/sign-out" method="post">
          <DropdownMenuItem asChild>
            <button type="submit" className="w-full cursor-pointer">
              <LogOut className="size-4" aria-hidden />
              {copy.nav.signOut}
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

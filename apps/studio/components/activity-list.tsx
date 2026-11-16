import { Bot, User } from 'lucide-react';
import { copy } from '@/lib/copy';
import { formatUsd, timeAgo } from '@/lib/format';
import type { ActivityItem } from '@/lib/types';
import { cn } from '@/lib/utils';

export function ActivityList({ items }: { items: ActivityItem[] | null }) {
  if (items === null) {
    return (
      <p role="alert" className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
        {copy.agent.activity.loadFailed}
      </p>
    );
  }
  if (items.length === 0) {
    return <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">{copy.agent.activity.empty}</p>;
  }
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {items.map((it) => (
        <li key={it.id} className="flex items-start gap-3 px-5 py-4">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
            {it.kind === 'you' ? <User className="size-4" aria-hidden /> : <Bot className="size-4" aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{it.title}</p>
            <p className="text-xs text-muted-foreground">
              {it.kind === 'you' ? copy.agent.activity.you : copy.agent.activity.other} · {timeAgo(it.at)}
            </p>
          </div>
          <div className="text-right text-xs">
            <p className={cn('font-medium', it.ok ? 'text-success' : 'text-warning')}>{it.ok ? copy.agent.activity.done : copy.agent.activity.failed}</p>
            {it.ok ? <p className="tabular-nums text-muted-foreground">{it.kind === 'other' ? copy.agent.activity.earned(formatUsd(it.amountUsd)) : copy.agent.activity.spent(formatUsd(it.amountUsd))}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

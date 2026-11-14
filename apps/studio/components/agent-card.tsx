import Link from 'next/link';
import { StatusBadge } from '@/components/status-badge';
import { formatUsd } from '@/lib/format';
import { copy } from '@/lib/copy';
import type { Agent } from '@/lib/types';

export function AgentCard({ agent }: { agent: Agent }) {
  return (
    <Link
      href={`/agents/${agent.id}`}
      className="group flex flex-col gap-4 rounded-xl border bg-card p-5 transition-colors hover:border-ring/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[15px] leading-6 font-semibold tracking-tight">{agent.name}</h2>
        <StatusBadge status={agent.status} />
      </div>
      <p className="line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">{agent.summary}</p>
      <dl className="mt-auto flex gap-6 border-t pt-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">{copy.agents.creditLeft}</dt>
          <dd className="font-medium tabular-nums">{formatUsd(agent.creditUsd)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{copy.agents.earned}</dt>
          <dd className="font-medium tabular-nums">{formatUsd(agent.earnedUsd)}</dd>
        </div>
      </dl>
    </Link>
  );
}

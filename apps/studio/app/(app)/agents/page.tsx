import { Lightbulb, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AgentCard } from '@/components/agent-card';
import { Button } from '@/components/ui/button';
import { copy } from '@/lib/copy';
import { listAgents } from '@/lib/data';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: copy.agents.title };
export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const session = await requireSession('/agents');
  const agents = await listAgents(session).catch(() => null);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{copy.agents.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{copy.agents.subtitle}</p>
        </div>
        <Button asChild>
          <Link href="/agents/new">
            <Plus aria-hidden />
            {copy.agents.create}
          </Link>
        </Button>
      </div>

      {agents === null ? (
        <p role="alert" className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
          {copy.errors.generic}
        </p>
      ) : agents.length === 0 ? (
        <section aria-labelledby="empty-title" className="rounded-xl border bg-card p-6 sm:p-8">
          <h2 id="empty-title" className="text-lg font-semibold tracking-tight">
            {copy.agents.empty.title}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{copy.agents.empty.body}</p>
          <ul className="mt-6 grid gap-3 md:grid-cols-3">
            {copy.agents.ideas.map((idea) => (
              <li key={idea.title}>
                <Link
                  href={`/agents/new?idea=${encodeURIComponent(idea.title)}`}
                  className="group flex h-full flex-col gap-2 rounded-lg border p-4 transition-colors hover:border-ring/60 hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <Lightbulb className="size-4 text-muted-foreground" aria-hidden />
                  <span className="text-sm font-medium">{idea.title}</span>
                  <span className="text-sm text-muted-foreground">{idea.body}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <li key={a.id}>
              <AgentCard agent={a} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

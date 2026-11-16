import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AgentTabs } from '@/components/agent-tabs';
import { PublishDialog } from '@/components/publish-dialog';
import { StatusBadge } from '@/components/status-badge';
import { getAgent, sampleActivity } from '@/lib/data';
import { appMode } from '@/lib/mode';
import { requireSession } from '@/lib/session';
import { agentsFor } from '@/lib/services';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const session = await requireSession(`/agents/${id}`);
  return { title: (await getAgent(session, id).catch(() => null))?.name ?? 'Agent' };
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession(`/agents/${id}`);
  // Only an agent that is not in the person's list is "nothing here": when the list cannot be read, the error page says so.
  const agent = await getAgent(session, id);
  if (!agent) notFound();
  const mode = appMode();
  // Preview shows sample activity; otherwise the person's own tries and uses by other agents. `null` means it could not be read.
  const activity = mode === 'preview' ? sampleActivity() : mode === 'live' ? await agentsFor(session).activity(id).catch(() => null) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
            <StatusBadge status={agent.status} />
          </div>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{agent.summary}</p>
        </div>
        {agent.status !== 'live' ? <PublishDialog agent={agent} mode={mode} /> : null}
      </div>
      <AgentTabs agent={agent} activity={activity} mode={mode} />
    </div>
  );
}

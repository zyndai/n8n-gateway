import type { Metadata } from 'next';
import { Builder } from '@/components/builder';
import { copy } from '@/lib/copy';
import { appMode } from '@/lib/mode';
import { requireSession } from '@/lib/session';
import { agentsFor } from '@/lib/services';

export const metadata: Metadata = { title: copy.create.title };
export const dynamic = 'force-dynamic';

export default async function NewAgentPage({ searchParams }: { searchParams: Promise<{ idea?: string; agent?: string }> }) {
  const session = await requireSession('/agents/new');
  const { idea, agent } = await searchParams;
  const mode = appMode();

  // An agent id in the address is only used when it is one of this person's own agents.
  let agentId: string | undefined;
  if (mode === 'live' && agent) {
    agentId = await agentsFor(session)
      .load(agent)
      .then((l) => l.id)
      .catch(() => undefined);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{copy.create.title}</h1>
      <Builder mode={mode} {...(agentId ? { agentId } : {})} initialIdea={idea?.slice(0, 300)} />
    </div>
  );
}

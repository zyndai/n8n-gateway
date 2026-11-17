'use client';

import { ActivityList } from '@/components/activity-list';
import { Builder } from '@/components/builder';
import { ChatWorkspace, type NetworkStart } from '@/components/chat-workspace';
import { SettingsPanel } from '@/components/settings-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { copy } from '@/lib/copy';
import type { ActivityItem, Agent, BuilderMode } from '@/lib/types';

export function AgentTabs({ agent, activity, mode, network }: { agent: Agent; activity: ActivityItem[] | null; mode: BuilderMode; network: NetworkStart | null }) {
  const t = copy.agent.tabs;
  // Changes are made by chat, on an agent that has been built. In preview every agent can be changed.
  const canEdit = mode === 'preview' || (mode === 'live' && agent.hasWorkflow);
  return (
    <Tabs defaultValue="chat" className="gap-5">
      <TabsList>
        <TabsTrigger value="chat">{t.chat}</TabsTrigger>
        {canEdit ? <TabsTrigger value="edit">{t.edit}</TabsTrigger> : null}
        <TabsTrigger value="activity">{t.activity}</TabsTrigger>
        <TabsTrigger value="settings">{t.settings}</TabsTrigger>
      </TabsList>
      <TabsContent value="chat">
        <ChatWorkspace agentId={agent.id} agentName={agent.name} mode={mode} built={agent.hasWorkflow} creditUsd={agent.creditUsd} network={network} />
      </TabsContent>
      {canEdit ? (
        <TabsContent value="edit">
          <Builder mode={mode} agentId={agent.id} editing={{ live: agent.status === 'live' }} />
        </TabsContent>
      ) : null}
      <TabsContent value="activity">
        <ActivityList items={activity} />
      </TabsContent>
      <TabsContent value="settings">
        <SettingsPanel agent={agent} mode={mode} />
      </TabsContent>
    </Tabs>
  );
}

'use client';

import { ActivityList } from '@/components/activity-list';
import { ChatPanel } from '@/components/chat-panel';
import { SettingsPanel } from '@/components/settings-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { copy } from '@/lib/copy';
import type { ActivityItem, Agent, BuilderMode } from '@/lib/types';

export function AgentTabs({ agent, activity, mode }: { agent: Agent; activity: ActivityItem[]; mode: BuilderMode }) {
  const t = copy.agent.tabs;
  return (
    <Tabs defaultValue="chat" className="gap-5">
      <TabsList>
        <TabsTrigger value="chat">{t.chat}</TabsTrigger>
        <TabsTrigger value="activity">{t.activity}</TabsTrigger>
        <TabsTrigger value="settings">{t.settings}</TabsTrigger>
      </TabsList>
      <TabsContent value="chat">
        <ChatPanel agentId={agent.id} mode={mode} built={agent.hasWorkflow} />
      </TabsContent>
      <TabsContent value="activity">
        <ActivityList items={activity} />
      </TabsContent>
      <TabsContent value="settings">
        <SettingsPanel agent={agent} mode={mode} />
      </TabsContent>
    </Tabs>
  );
}

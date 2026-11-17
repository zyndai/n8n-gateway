'use client';

import { AlertCircle, Bot, Brain, Check, Database, Globe, Inbox, Loader2, MessageSquare, Network, Send } from 'lucide-react';
import type { Activity, Part, PartKind, PartState } from '@/lib/builder/events';
import { copy } from '@/lib/copy';
import { formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

const ICON: Record<PartKind, typeof Bot> = { network: Network, chat: MessageSquare, request: Inbox, brain: Brain, helper: Bot, source: Database, web: Globe, answer: Send };

/** How a part looks in each state. Planned parts are outlines; built ones are solid; tried ones light up. */
const LOOK: Record<PartState, string> = {
  planned: 'border-dashed bg-transparent text-muted-foreground',
  building: 'border-primary/30 bg-primary/5 animate-pulse motion-reduce:animate-none',
  ready: 'bg-card',
  testing: 'border-primary/40 bg-card ring-2 ring-primary/15',
  used: 'border-primary/50 bg-primary/5',
  failed: 'border-destructive/40 bg-destructive/5',
};

function StateMark({ state }: { state: PartState }) {
  if (state === 'building' || state === 'testing') return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />;
  if (state === 'ready' || state === 'used') return <Check className={cn('size-3.5 shrink-0', state === 'used' ? 'text-primary' : 'text-success')} aria-hidden />;
  if (state === 'failed') return <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />;
  return null;
}

/** One step of the agent: an icon, what it is, and its state. */
function Block({ part, className }: { part: Part; className?: string }) {
  const Icon = ICON[part.kind];
  const title = part.kind === 'helper' || part.kind === 'source' ? (part.label ?? copy.build.parts[part.kind]) : copy.build.parts[part.kind];
  return (
    <div
      className={cn('flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors duration-300 animate-in fade-in slide-in-from-top-1 motion-reduce:animate-none', LOOK[part.state], className)}
      title={`${title}: ${copy.build.states[part.state]}`}
    >
      <Icon className={cn('size-3.5 shrink-0', part.state === 'failed' ? 'text-destructive' : part.state === 'planned' ? 'text-muted-foreground' : 'text-foreground/70')} aria-hidden />
      <span className="min-w-0 flex-1 break-words font-medium leading-tight">{title}</span>
      <StateMark state={part.state} />
    </div>
  );
}

/** A short line between steps. While the agent is tried, a dot runs down it. */
function Connector({ active }: { active: boolean }) {
  return (
    <div className="relative mx-auto h-4 w-px overflow-visible bg-border" aria-hidden>
      {active ? <span className="animate-flow absolute -left-[2.5px] top-0 size-1.5 rounded-full bg-primary" /> : null}
    </div>
  );
}

/** One tool the agent can use, with its price, and what it cost in the last try. */
function ToolRow({ part }: { part: Part }) {
  const Icon = ICON[part.kind];
  const name = part.kind === 'web' ? copy.build.parts.web : (part.label ?? copy.build.parts[part.kind]);
  return (
    <li
      className={cn('flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors duration-300 animate-in fade-in slide-in-from-left-1 motion-reduce:animate-none', LOOK[part.state])}
      title={copy.build.states[part.state]}
    >
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', part.state === 'failed' ? 'text-destructive' : 'text-foreground/60')} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{name}</span>
        {part.state === 'used' && part.costUsd ? (
          <span className="block text-primary">{copy.build.paid(formatUsd(part.costUsd))}</span>
        ) : part.state === 'failed' ? (
          <span className="block text-destructive">{copy.build.states.failed}</span>
        ) : part.priceUsd ? (
          <span className="block text-muted-foreground">{copy.build.perUse(formatUsd(part.priceUsd))}</span>
        ) : null}
      </span>
      <StateMark state={part.state} />
    </li>
  );
}

/**
 * The agent as a small picture that fills in while it is built (S5.3): the two ways in, the request, the AI step with
 * the tools it can use, and the answer. Every state comes from Studio's own events, so what shows is what happened.
 */
export function AgentBlueprint({ parts }: { parts: Part[] }) {
  const find = (kind: PartKind) => parts.find((p) => p.kind === kind);
  const tools = parts.filter((p) => p.kind === 'helper' || p.kind === 'source' || p.kind === 'web');
  const network = find('network');
  const chat = find('chat');
  const request = find('request');
  const brain = find('brain');
  const answer = find('answer');
  const flowing = (p?: Part) => p?.state === 'testing';

  return (
    <div className="space-y-0" role="img" aria-label={parts.map((p) => `${p.label ?? copy.build.parts[p.kind]}: ${copy.build.states[p.state]}`).join(', ')}>
      <div className="grid grid-cols-2 gap-2">
        {network ? <Block part={network} /> : null}
        {chat ? <Block part={chat} /> : null}
      </div>
      <Connector active={flowing(chat)} />
      {request ? <Block part={request} /> : null}
      <Connector active={flowing(request)} />
      {brain ? (
        <div className={cn('rounded-xl border p-2 transition-colors duration-300', brain.state === 'planned' ? 'border-dashed' : brain.state === 'testing' || brain.state === 'used' ? 'border-primary/40' : '')}>
          <Block part={brain} className="border-0 bg-transparent px-0.5 py-0.5 ring-0" />
          <p className="mt-2 px-0.5 text-[11px] font-medium text-muted-foreground">{copy.build.usesTitle}</p>
          {tools.length ? (
            <ul className="mt-1 space-y-1">
              {tools.map((t) => (
                <ToolRow key={t.id} part={t} />
              ))}
            </ul>
          ) : (
            <p className="mt-1 px-0.5 text-xs text-muted-foreground">{copy.build.noTools}</p>
          )}
        </div>
      ) : null}
      <Connector active={flowing(brain)} />
      {answer ? <Block part={answer} /> : null}
    </div>
  );
}

/** What the builder did and is doing, newest at the bottom, in plain words. */
export function BuildActivity({ items }: { items: Activity[] }) {
  return (
    <ol className="space-y-2" aria-live="polite">
      {items.map((a) => (
        <li key={a.id} className="flex items-start gap-2 text-xs leading-5 animate-in fade-in motion-reduce:animate-none">
          {a.state === 'running' ? (
            <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
          ) : a.state === 'done' ? (
            <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
          ) : (
            <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
          )}
          <span className={cn('min-w-0 break-words', a.state === 'running' ? 'font-medium text-foreground' : 'text-muted-foreground')}>{a.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** Parts for an agent known only from its preview (before any event, or after a reload): all ready, or all planned. */
export function partsFromDraft(helpers: readonly { name: string; what: string; priceUsd: string }[], built: boolean): Part[] {
  const state: PartState = built ? 'ready' : 'planned';
  const base = (kind: PartKind): Part => ({ id: kind, kind, state });
  return [base('network'), base('chat'), base('request'), base('brain'), ...helpers.map((h) => ({ id: `tool:${h.name}`, kind: 'helper' as const, label: h.name, detail: h.what, priceUsd: h.priceUsd, state })), base('answer')];
}

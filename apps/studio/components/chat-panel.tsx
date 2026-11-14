'use client';

import { Loader2, Send } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiMessage, copy } from '@/lib/copy';
import { formatUsd } from '@/lib/format';
import { SAMPLE_CHAT } from '@/lib/sample';
import { useStoredText } from '@/lib/use-stored';
import type { ChatTurn, BuilderMode } from '@/lib/types';
import { cn } from '@/lib/utils';

const POLL_MS = 1500;
const GIVE_UP_MS = 300_000;
const storeKey = (id: string) => `studio.chat.${id}`;

interface RunReply {
  status: 'running' | 'success' | 'error' | 'canceled';
  answer?: string;
  helpers?: { name: string; costUsd: string; ok: boolean }[];
  costUsd?: string;
  errorKind?: string;
  error?: string;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseTurns(raw: string | null | undefined): ChatTurn[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as ChatTurn[]).filter((t) => (t.role === 'user' || t.role === 'agent') && typeof t.text === 'string').slice(-30) : [];
  } catch {
    return [];
  }
}

export function ChatPanel(props: { agentId: string; mode: BuilderMode; built: boolean }) {
  const raw = useStoredText(props.mode === 'live' && props.built ? storeKey(props.agentId) : null);
  if (raw === undefined) return <div className="h-[min(34rem,calc(100vh-17rem))] min-h-[24rem] animate-pulse rounded-xl border bg-card" aria-hidden />;
  return <ChatView {...props} saved={parseTurns(raw)} />;
}

function ChatView({ agentId, mode, built, saved }: { agentId: string; mode: BuilderMode; built: boolean; saved: ChatTurn[] }) {
  const demo = mode === 'preview';
  const live = mode === 'live' && built;
  const [turns, setTurns] = useState<ChatTurn[]>(demo ? SAMPLE_CHAT.slice(0, 2) : saved);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!live) return;
    try {
      window.localStorage.setItem(storeKey(agentId), JSON.stringify(turns.slice(-30)));
    } catch {
      /* the chat just does not come back after a reload */
    }
  }, [live, agentId, turns]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns, busy]);

  const add = (t: ChatTurn) => alive.current && setTurns((prev) => [...prev, t]);

  async function sendDemo() {
    await wait(1400);
    add(SAMPLE_CHAT[1] as ChatTurn);
  }

  async function sendLive(text: string, history: ChatTurn[]) {
    const start = await fetch(`/api/agents/${encodeURIComponent(agentId)}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: history.slice(-6).map((t) => ({ role: t.role, text: t.text })) }),
    });
    const started = (await start.json().catch(() => ({}))) as { runId?: string; error?: string };
    if (!start.ok || !started.runId) return add({ role: 'agent', text: apiMessage(started.error) });

    const until = Date.now() + GIVE_UP_MS;
    while (alive.current && Date.now() < until) {
      await wait(POLL_MS);
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(started.runId)}`, { cache: 'no-store' });
      const run = (await res.json().catch(() => ({}))) as RunReply;
      if (!res.ok) return add({ role: 'agent', text: apiMessage(run.error) });
      if (run.status === 'running') continue;
      if (run.status === 'success' && run.answer) {
        const helpers = run.helpers ?? [];
        return add({
          role: 'agent',
          text: run.answer,
          used: { helpers: helpers.length, costUsd: run.costUsd ?? '0' },
          details: helpers.map((h) => `${h.name} · ${h.ok ? formatUsd(h.costUsd) : 'did not answer'}`),
        });
      }
      return add({ role: 'agent', text: apiMessage(undefined, run.errorKind) });
    }
    if (alive.current) add({ role: 'agent', text: apiMessage(undefined, 'timeout') });
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || !(demo || live)) return;
    const history = turns;
    setInput('');
    add({ role: 'user', text });
    setBusy(true);
    try {
      if (demo) await sendDemo();
      else await sendLive(text, history);
    } catch {
      add({ role: 'agent', text: copy.errors.generic });
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const enabled = demo || live;
  return (
    <div className="flex h-[min(34rem,calc(100vh-17rem))] min-h-[24rem] flex-col rounded-xl border bg-card">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5" aria-live="polite">
        {mode === 'off' ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{copy.agent.notAvailable}</p> : null}
        {mode === 'live' && !built ? (
          <div className="space-y-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            <p>{copy.agent.notBuilt}</p>
            <Button asChild size="sm" variant="outline">
              <Link href={`/agents/new?agent=${encodeURIComponent(agentId)}`}>{copy.agent.finishBuilding}</Link>
            </Button>
          </div>
        ) : null}
        {enabled && turns.length === 0 ? <p className="text-sm text-muted-foreground">{copy.agent.chatEmpty}</p> : null}
        {turns.map((t, i) => (
          <Turn key={i} turn={t} />
        ))}
        {busy ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {copy.agent.working}
          </p>
        ) : null}
        <div ref={endRef} />
      </div>
      <form
        className="flex items-end gap-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={copy.agent.chatPlaceholder}
          aria-label={copy.agent.chatPlaceholder}
          rows={2}
          maxLength={4000}
          disabled={!enabled}
          className="min-h-11 resize-none shadow-none"
        />
        <Button type="submit" size="icon-lg" disabled={!enabled || !input.trim() || busy} aria-label={copy.create.send}>
          <Send aria-hidden />
        </Button>
      </form>
    </div>
  );
}

function Turn({ turn }: { turn: ChatTurn }) {
  const [open, setOpen] = useState(false);
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-sm leading-6 text-primary-foreground">{turn.text}</p>
      </div>
    );
  }
  return (
    <div className="max-w-[90%] space-y-2">
      <p className="rounded-2xl bg-secondary px-4 py-3 text-sm leading-6 whitespace-pre-wrap">{turn.text}</p>
      {turn.used ? (
        <div className="px-1 text-xs text-muted-foreground">
          <span>{turn.used.helpers === 0 ? copy.agent.usedNone : copy.agent.used(turn.used.helpers, formatUsd(turn.used.costUsd))}</span>
          {turn.details?.length ? (
            <>
              {' · '}
              <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="rounded underline underline-offset-2 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
                {open ? copy.agent.hideDetails : copy.agent.details}
              </button>
            </>
          ) : null}
          {open && turn.details ? (
            <ul className={cn('mt-2 space-y-1 rounded-lg border bg-background p-3 font-mono text-[11px] leading-5')}>
              {turn.details.map((d, i) => (
                <li key={`${i}-${d}`}>{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

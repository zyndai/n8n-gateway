'use client';

// S6: the chat on the left and, beside it, a live picture of what the agent does while it answers: the credit it has,
// the agents it looks for, finds, asks and pays. The chat reports each step of a run here as it learns of it.
import { ChevronDown, Network } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChatPanel, type RunEvent } from '@/components/chat-panel';
import { NetworkGraph, type GraphHandle } from '@/components/network-graph';
import { Button } from '@/components/ui/button';
import { copy } from '@/lib/copy';
import { buildGraph, fromMicros, nodeIdOf, toMicros, type CallState, type NetCall, type SavedCall, type ToolView } from '@/lib/network';
import { SAMPLE_NET_TOOLS } from '@/lib/sample';
import type { BuilderMode, ChatTurn } from '@/lib/types';
import { cn } from '@/lib/utils';

/** The ring shows what is left of the most the agent has had, but never of less than this: a nearly empty agent looks nearly empty. */
const RING_FLOOR_USD = 1;
/** How long a finished run stays on the picture, so its last steps can play out. */
const LINGER_MS = 3000;
/** When to ask again what the agent has left after a run: the payment takes a moment to show. */
const SETTLE_AT_MS = [1500, 5000, 11000];

export interface NetworkStart {
  creditUsd: string | null;
  tools: ToolView[];
}

const NO_TOOLS: ToolView[] = [];

const paidSoFar = (calls: readonly NetCall[]) => calls.reduce((sum, c) => (c.kind !== 'search' && c.state === 'done' ? sum + toMicros(c.paidUsd) : sum), 0);

export function ChatWorkspace(props: { agentId: string; agentName: string; mode: BuilderMode; built: boolean; creditUsd: string | null; network: NetworkStart | null }) {
  const { agentId, agentName, mode, built } = props;
  const demo = mode === 'preview';
  const show = demo || (mode === 'live' && built);
  const tools = demo ? SAMPLE_NET_TOOLS : (props.network?.tools ?? NO_TOOLS);

  const graph = useRef<GraphHandle>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [live, setLive] = useState<NetCall[]>([]);
  const [running, setRunning] = useState(false);
  const [linger, setLinger] = useState<SavedCall[] | null>(null);
  const [credit, setCredit] = useState<string | null>(props.network?.creditUsd ?? props.creditUsd);
  const [peak, setPeak] = useState<number>(Number(props.network?.creditUsd ?? props.creditUsd ?? 0) || 0);
  const [spent, setSpent] = useState(0);
  const [open, setOpen] = useState(false);

  const seen = useRef(new Map<string, CallState>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const base = useRef({ credit: Number(props.network?.creditUsd ?? props.creditUsd ?? 0) || 0, spent: 0 });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const set = timers.current;
    return () => {
      alive.current = false;
      set.forEach(clearTimeout);
      clearTimeout(lingerTimer.current);
    };
  }, []);

  const after = (ms: number, f: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      if (alive.current) f();
    }, ms);
    timers.current.add(t);
  };

  /** Plays the steps of a run that are new since the last look: what started, what was found, what was paid. */
  function replay(calls: readonly NetCall[]) {
    const g = graph.current;
    for (const c of calls) {
      const before = seen.current.get(c.id);
      if (before === c.state) continue;
      seen.current.set(c.id, c.state);
      const name = c.name ?? c.tool;
      if (c.kind === 'search') {
        if (before === undefined) g?.play({ type: 'search', ...(c.query ? { query: c.query } : {}) });
        if (c.state === 'done') g?.play({ type: 'found', ids: (c.found ?? []).map((f) => `agent:${f.entityId}`), count: c.found?.length ?? 0 });
        continue;
      }
      const id = nodeIdOf(c);
      if (before === undefined) g?.play({ type: 'talk', id, name });
      if (c.state === 'done') after(before === undefined ? 700 : 0, () => g?.play({ type: 'paid', id, name, ...(c.paidUsd ? { amountUsd: c.paidUsd } : {}) }));
      else if (c.state === 'failed') after(before === undefined ? 700 : 0, () => g?.play({ type: 'failed', id, name }));
    }
  }

  /** After a run: ask what the agent has left until the payments show, then stop subtracting them ourselves. */
  function settle() {
    if (demo) {
      after(LINGER_MS, () => {
        const left = Math.max(0, base.current.credit - base.current.spent / 1_000_000);
        base.current = { credit: left, spent: 0 };
        setCredit(left.toFixed(6));
        setSpent(0);
      });
      return;
    }
    SETTLE_AT_MS.forEach((ms, i) => {
      after(ms, async () => {
        const last = i === SETTLE_AT_MS.length - 1;
        let read: string | null = null;
        try {
          const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/network`, { cache: 'no-store' });
          if (res.ok) read = ((await res.json()) as { creditUsd?: string | null }).creditUsd ?? null;
        } catch {
          /* try again at the next time, or estimate */
        }
        if (!alive.current || base.current.spent === 0) return;
        const expected = base.current.credit - base.current.spent / 1_000_000;
        if (read !== null && Number(read) <= expected + 0.0005) {
          base.current = { credit: Number(read), spent: 0 };
          setCredit(read);
          setPeak((p) => Math.max(p, Number(read)));
          setSpent(0);
        } else if (last) {
          base.current = { credit: Math.max(0, expected), spent: 0 };
          setCredit(Math.max(0, expected).toFixed(6));
          setSpent(0);
        }
      });
    });
  }

  function onRun(e: RunEvent) {
    if (e.type === 'start') {
      clearTimeout(lingerTimer.current);
      seen.current.clear();
      base.current = { credit: Number(credit ?? 0) || 0, spent: 0 };
      setLinger(null);
      setLive([]);
      setSpent(0);
      setRunning(true);
      setOpen(true);
      graph.current?.play({ type: 'start' });
    } else if (e.type === 'calls') {
      setLive(e.calls);
      const paid = paidSoFar(e.calls);
      base.current.spent = paid;
      setSpent(paid);
      replay(e.calls);
    } else {
      setRunning(false);
      setLinger(e.saved);
      graph.current?.play({ type: 'end' });
      lingerTimer.current = setTimeout(() => {
        if (!alive.current) return;
        setLive([]);
        setLinger(null);
      }, LINGER_MS);
      if (base.current.spent > 0) settle();
    }
  }

  // What the agent used in earlier answers, kept with the chat. The answer that just ended stays out while it lingers as a live run.
  const history = useMemo(() => turns.filter((t) => t.net && t.net !== linger).flatMap((t) => t.net as SavedCall[]), [turns, linger]);
  const nodes = useMemo(() => buildGraph({ tools, history, live }), [tools, history, live]);

  const shown = credit === null ? null : fromMicros(Math.max(0, Math.round(Number(credit) * 1_000_000) - spent));
  const ring = Math.max(peak, RING_FLOOR_USD).toFixed(6);

  const chat = <ChatPanel agentId={agentId} mode={mode} built={built} onRun={onRun} onTurns={setTurns} />;
  if (!show) return chat;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="order-2 min-w-0 lg:order-1">{chat}</div>
      <div className="order-1 min-w-0 space-y-2 lg:order-2">
        <Button type="button" variant="outline" size="sm" className="w-full justify-between lg:hidden" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="flex items-center gap-2">
            <Network aria-hidden />
            {open ? copy.network.hide : copy.network.show}
          </span>
          <ChevronDown className={cn('transition-transform', open && 'rotate-180')} aria-hidden />
        </Button>
        <NetworkGraph
          ref={graph}
          agentName={agentName}
          creditUsd={shown}
          peakUsd={ring}
          nodes={nodes}
          live={live}
          running={running}
          className={cn(open ? 'flex' : 'hidden', 'h-[24rem] lg:flex lg:h-[min(34rem,calc(100vh-17rem))] lg:min-h-[24rem]')}
        />
      </div>
    </div>
  );
}

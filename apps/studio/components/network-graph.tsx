'use client';

// S6: the live picture of an agent's network. The agent sits in the middle with its credit as a ring; its own helpers
// and every agent it finds and hires gather around it. While it answers: a radar sweep with the search words, found
// agents arriving, pulses going out and coming back while they talk, a coin and a "-$0.05" tag when one is paid, and
// the credit counting down. Everything drawn is a fact Studio read from the run: nothing here is made up.
//
// The picture is one SVG (so it scales as a whole); cards are HTML inside it. Things that move fast (pulses, coins, the
// counter) are written straight to the DOM so React does not re-render sixty times a second. Events arrive through the
// `ref` (`play`), from the chat's poll loop, never from an effect.
import { Bot, Database, Globe, Sparkles } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import { copy } from '@/lib/copy';
import { formatUsd } from '@/lib/format';
import { fromMicros, totalPaidMicros, type GraphNode, type NetCall } from '@/lib/network';
import { cn } from '@/lib/utils';

// A tall, narrow canvas: the picture sits in a column about 40% of the page wide.
export const W = 480;
export const H = 520;
const CX = W / 2;
const CY = H / 2;
const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** What the chat tells the picture as a run goes on. */
export type GraphEvent =
  | { type: 'start' }
  | { type: 'search'; query?: string }
  | { type: 'found'; ids: string[]; count: number }
  | { type: 'talk'; id: string; name: string }
  | { type: 'paid'; id: string; name: string; amountUsd?: string }
  | { type: 'failed'; id: string; name: string }
  | { type: 'end' };

export interface GraphHandle {
  play(e: GraphEvent): void;
}

interface Pos {
  x: number;
  y: number;
  angle: number;
  ring: 'main' | 'outer';
}
type Layout = ReadonlyMap<string, Pos>;

const RINGS = { main: { rx: 140, ry: 190 }, outer: { rx: 172, ry: 228 } } as const;

function place(angle: number, ring: Pos['ring']): Pos {
  const r = RINGS[ring];
  const a = (angle * Math.PI) / 180;
  return { x: CX + r.rx * Math.cos(a), y: CY + r.ry * Math.sin(a), angle, ring };
}

const angleGap = (a: number, b: number) => {
  const d = Math.abs(((a - b + 540) % 360) - 180);
  return d;
};

/** The angle farthest from every angle already used, so cards spread round the agent and never stack. */
function pickAngle(used: number[]): number {
  if (used.length === 0) return -24;
  let best = -24;
  let bestGap = -1;
  for (let a = -180; a < 180; a += 6) {
    const gap = Math.min(...used.map((u) => angleGap(a, u)));
    if (gap > bestGap + 0.001) {
      bestGap = gap;
      best = a;
    }
  }
  return best;
}

/** Gives every new thing a place and frees the places of things that went; the same map when nothing changed. */
function extend(prev: Layout, nodes: readonly GraphNode[]): Layout {
  const ids = new Set(nodes.map((n) => n.id));
  const next = new Map(prev);
  let changed = false;
  for (const id of prev.keys()) {
    if (!ids.has(id)) {
      next.delete(id);
      changed = true;
    }
  }
  for (const n of nodes) {
    const ring: Pos['ring'] = n.kind === 'candidate' ? 'outer' : 'main';
    const have = next.get(n.id);
    if (!have) {
      next.set(n.id, place(pickAngle([...next.values()].map((p) => p.angle)), ring));
      changed = true;
    } else if (have.ring !== ring) {
      next.set(n.id, place(have.angle, ring));
      changed = true;
    }
  }
  return changed ? next : prev;
}

/** A gentle curve from the agent to a card, bent a little to one side or the other. */
function linkPath(to: Pos, bend: number): string {
  const mx = (CX + to.x) / 2;
  const my = (CY + to.y) / 2;
  const dx = to.x - CX;
  const dy = to.y - CY;
  const len = Math.hypot(dx, dy) || 1;
  const k = bend * 0.14 * len;
  return `M ${CX} ${CY} Q ${(mx - (dy / len) * k).toFixed(1)} ${(my + (dx / len) * k).toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

const hashBend = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return h % 2 === 0 ? 1 : -1;
};

// --- motion written straight to the DOM -------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const ease = (u: number) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

/** A small light running along a link, out from the agent or back to it. */
function glide(layer: SVGGElement, path: SVGPathElement, o: { dir: 'out' | 'in'; color: string; r: number; dur: number; stroke?: string; delay?: number }) {
  const el = document.createElementNS(SVG_NS, 'circle');
  el.setAttribute('r', String(o.r));
  el.setAttribute('fill', o.color);
  el.setAttribute('stroke', o.stroke ?? '#ffffff');
  el.setAttribute('stroke-width', o.stroke ? '1.5' : '1');
  el.setAttribute('opacity', '0');
  layer.appendChild(el);
  const len = path.getTotalLength();
  let t0 = 0;
  const step = (now: number) => {
    if (!path.isConnected) return el.remove();
    if (!t0) t0 = now + (o.delay ?? 0);
    const u = Math.min(1, Math.max(0, (now - t0) / o.dur));
    const p = path.getPointAtLength(len * (o.dir === 'out' ? ease(u) : 1 - ease(u)));
    el.setAttribute('cx', p.x.toFixed(1));
    el.setAttribute('cy', p.y.toFixed(1));
    el.setAttribute('opacity', u <= 0 ? '0' : String(Math.min(1, Math.sin(Math.PI * u) * 1.6)));
    if (u < 1) requestAnimationFrame(step);
    else el.remove();
  };
  requestAnimationFrame(step);
}

/** A gold coin with a short tail, from the agent to the one it pays. */
function coin(layer: SVGGElement, path: SVGPathElement) {
  glide(layer, path, { dir: 'out', color: '#fbbf24', stroke: '#b45309', r: 5.5, dur: 950 });
  glide(layer, path, { dir: 'out', color: '#fcd34d', r: 3, dur: 950, delay: 70 });
  glide(layer, path, { dir: 'out', color: '#fde68a', r: 1.8, dur: 950, delay: 140 });
}

/** A number that counts to its new value instead of jumping. */
function Counter({ usd, reduced }: { usd: string | null; reduced: boolean }) {
  const ref = useRef<SVGTextElement>(null);
  const shown = useRef<number>(NaN);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = usd === null ? NaN : Number(usd);
    if (!Number.isFinite(target)) {
      el.textContent = '—';
      shown.current = NaN;
      return;
    }
    const from = Number.isFinite(shown.current) ? shown.current : target;
    if (reduced || from === target) {
      shown.current = target;
      el.textContent = formatUsd(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / 1100);
      const v = from + (target - from) * ease(u);
      shown.current = v;
      el.textContent = formatUsd(v);
      if (u < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [usd, reduced]);
  return (
    <text ref={ref} x={CX} y={CY + 8} textAnchor="middle" fill="#18181b" fontSize="19" fontWeight="600" style={{ fontVariantNumeric: 'tabular-nums' }}>
      —
    </text>
  );
}

const subscribeMotion = (cb: () => void) => {
  const q = window.matchMedia('(prefers-reduced-motion: reduce)');
  q.addEventListener('change', cb);
  return () => q.removeEventListener('change', cb);
};
const useReducedMotion = () =>
  useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  );

// --- the cards ---------------------------------------------------------------------------------------------------

const ICON = { helper: Sparkles, source: Database, web: Globe, agent: Bot, candidate: Bot } as const;
const KIND_LABEL: Record<GraphNode['kind'], string> = {
  helper: copy.network.ownHelper,
  source: copy.network.dataSource,
  web: copy.network.webReader,
  agent: copy.network.foundAgent,
  candidate: copy.network.candidate,
};

function Card({ node }: { node: GraphNode }) {
  const Icon = ICON[node.kind];
  const used = node.uses > 0;
  const state = node.state;
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col justify-center gap-0.5 rounded-lg border bg-white px-2.5 py-1.5 text-[12px] leading-tight shadow-sm transition-[border-color,background-color,box-shadow] duration-500',
        // every fill is solid, so a link never shows through a card
        state === 'calling' && 'border-violet-500 bg-violet-50 shadow-[0_0_0_3px_rgba(139,92,246,0.16)]',
        state === 'failed' && 'border-rose-300 bg-rose-50',
        state === 'idle' && used && 'border-violet-300 bg-[#faf8ff]',
        state === 'idle' && !used && 'border-border',
        node.kind === 'agent' && state === 'idle' && !used && 'border-violet-200',
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon className={cn('size-3 shrink-0', state === 'calling' ? 'text-violet-600' : state === 'failed' ? 'text-rose-500' : used ? 'text-violet-500' : 'text-zinc-400')} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium text-zinc-900">{node.label}</span>
        {state === 'calling' ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-violet-500" aria-hidden /> : null}
      </div>
      <div className="flex items-center justify-between gap-2 text-[10.5px] text-zinc-500">
        <span className="truncate">{node.priceUsd ? copy.network.perUse(formatUsd(node.priceUsd)) : KIND_LABEL[node.kind]}</span>
        {node.paidMicros > 0 ? <span className="shrink-0 font-medium text-amber-700 tabular-nums">{copy.network.paidTotal(formatUsd(fromMicros(node.paidMicros)))}</span> : null}
      </div>
    </div>
  );
}

function Chip({ node }: { node: GraphNode }) {
  return (
    <div className="flex h-full w-full items-center gap-1.5 rounded-full border border-dashed border-zinc-300 bg-white px-2.5 text-[10.5px] text-zinc-600">
      <span className="size-1.5 shrink-0 rounded-full bg-zinc-400" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{node.label}</span>
      {node.priceUsd ? <span className="shrink-0 text-zinc-400 tabular-nums">{formatUsd(node.priceUsd)}</span> : null}
    </div>
  );
}

interface Tag {
  key: number;
  id: string;
  text: string;
  tone: 'paid' | 'failed';
}
interface Burst {
  key: number;
  id: string;
}

const LOG_MAX = 8;

export interface NetworkGraphProps {
  agentName: string;
  /** What the agent has left to spend, a decimal string, or null when unknown. */
  creditUsd: string | null;
  /** The most it has had in this chat: the ring shows what is left of it. */
  peakUsd: string | null;
  nodes: readonly GraphNode[];
  /** The run in progress (or just finished). */
  live: readonly NetCall[];
  running: boolean;
  ref?: Ref<GraphHandle>;
  className?: string;
}

export function NetworkGraph({ agentName, creditUsd, peakUsd, nodes, live, running, ref, className }: NetworkGraphProps) {
  const reduced = useReducedMotion();
  const [layout, setLayout] = useState<Layout>(() => new Map());
  const next = extend(layout, nodes);
  if (next !== layout) setLayout(next);

  const [tags, setTags] = useState<Tag[]>([]);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const counter = useRef(0);
  const layer = useRef<SVGGElement>(null);
  const paths = useRef(new Map<string, SVGPathElement>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const set = timers.current;
    return () => set.forEach(clearTimeout);
  }, []);
  const later = (ms: number, f: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      f();
    }, ms);
    timers.current.add(t);
  };
  const note = (line: string) => setLog((l) => [...l, line].slice(-LOG_MAX));

  useImperativeHandle(
    ref,
    () => ({
      play(e) {
        const path = (id: string) => paths.current.get(id);
        switch (e.type) {
          case 'start':
            setLog([]);
            break;
          case 'search':
            note(e.query ? copy.network.searching(e.query) : copy.network.searchingPlain);
            break;
          case 'found': {
            note(e.count > 0 ? copy.network.found(`${e.count} ${e.count === 1 ? 'agent' : 'agents'}`) : copy.network.foundNone);
            const keyBase = ++counter.current;
            setBursts((b) => [...b, ...e.ids.map((id, i) => ({ key: keyBase * 100 + i, id }))]);
            later(1400, () => setBursts((b) => b.filter((x) => x.key < keyBase * 100 || x.key >= keyBase * 100 + 100)));
            break;
          }
          case 'talk':
            note(copy.network.talking(e.name));
            break;
          case 'paid': {
            const cost = Number(e.amountUsd ?? 0);
            note(cost > 0 ? copy.network.paid(e.name, formatUsd(e.amountUsd)) : copy.network.paidNothing(e.name));
            const p = path(e.id);
            if (p && layer.current && !reduced && cost > 0) coin(layer.current, p);
            if (cost > 0) {
              const key = ++counter.current;
              later(reduced ? 0 : 850, () => {
                setTags((t) => [...t, { key, id: e.id, text: `−${formatUsd(e.amountUsd)}`, tone: 'paid' }]);
                later(2700, () => setTags((t) => t.filter((x) => x.key !== key)));
              });
            }
            break;
          }
          case 'failed': {
            note(copy.network.failed(e.name));
            const key = ++counter.current;
            setTags((t) => [...t, { key, id: e.id, text: copy.network.failed(e.name), tone: 'failed' }]);
            later(3200, () => setTags((t) => t.filter((x) => x.key !== key)));
            break;
          }
          case 'end':
            note(copy.network.done);
            break;
        }
      },
    }),
    // `play` only reads refs and calls setters, so it does not need to change when the layout does
    [reduced],
  );

  // Pulses go out and come back along a link for as long as the agent is talking to what is on it.
  const talking = nodes.filter((n) => n.state === 'calling').map((n) => n.id).join('|');
  useEffect(() => {
    if (reduced || !talking) return;
    const ids = talking.split('|');
    const fire = () => {
      const g = layer.current;
      if (!g) return;
      for (const id of ids) {
        const p = paths.current.get(id);
        if (!p || !p.isConnected) continue;
        glide(g, p, { dir: 'out', color: '#8b5cf6', r: 3.4, dur: 620 });
        glide(g, p, { dir: 'in', color: '#c4b5fd', r: 2.8, dur: 620, delay: 560 });
      }
    };
    fire();
    const t = setInterval(fire, 1500);
    return () => clearInterval(t);
  }, [talking, reduced]);

  const searching = running && live.some((c) => c.kind === 'search' && c.state === 'calling');
  const asking = running && nodes.some((n) => n.state === 'calling');
  const query = live.find((c) => c.kind === 'search' && c.state === 'calling')?.query;
  const callingNode = nodes.find((n) => n.state === 'calling');
  const status = !running
    ? copy.network.idle
    : searching
      ? query
        ? copy.network.searching(query)
        : copy.network.searchingPlain
      : asking && callingNode
        ? copy.network.talking(callingNode.label)
        : copy.network.thinking;

  const credit = creditUsd === null ? null : Number(creditUsd);
  const peak = peakUsd === null ? null : Number(peakUsd);
  const fraction = credit !== null && Number.isFinite(credit) && peak !== null && peak > 0 ? Math.max(0.02, Math.min(1, credit / peak)) : 1;
  const spent = totalPaidMicros(nodes);
  const ordered = nodes.filter((n) => layout.has(n.id));

  return (
    <section className={cn('studio-net relative isolate flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm', className)} aria-label={copy.network.title}>
      <header className="relative z-10 flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('size-2 shrink-0 rounded-full', running ? 'animate-pulse bg-violet-500' : 'bg-success')} aria-hidden />
          <span className="truncate font-medium text-foreground">{status}</span>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
          <span>
            {copy.network.agentsMet} <b className="font-medium text-foreground tabular-nums">{nodes.filter((n) => n.uses > 0).length}</b>
          </span>
          <span>
            {copy.network.spent} <b className="font-medium text-amber-700 tabular-nums">{formatUsd(fromMicros(spent))}</b>
          </span>
        </div>
      </header>

      <div className="studio-net-canvas relative min-h-0 flex-1">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="absolute inset-0 size-full" role="img" aria-label={`${agentName}: ${copy.network.title}`}>
          <defs>
            <radialGradient id="sn-glow-c" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.16" />
              <stop offset="60%" stopColor="#8b5cf6" stopOpacity="0.05" />
              <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="sn-arc" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#a78bfa" />
              <stop offset="100%" stopColor="#7c3aed" />
            </linearGradient>
            <radialGradient id="sn-sweep" cx="0" cy="0" r="150" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0" />
              <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.2" />
            </radialGradient>
          </defs>

          {/* the quiet orbits */}
          <ellipse cx={CX} cy={CY} rx={RINGS.main.rx} ry={RINGS.main.ry} fill="none" stroke="#d4d4d8" strokeWidth="1" strokeDasharray="2 7" className="sn-orbit" />
          <ellipse cx={CX} cy={CY} rx={RINGS.outer.rx} ry={RINGS.outer.ry} fill="none" stroke="#e4e4e7" strokeWidth="1" strokeDasharray="1 9" className="sn-orbit" style={{ animationDirection: 'reverse' }} />
          <ellipse cx={CX} cy={CY} rx={92} ry={112} fill="none" stroke="#f4f4f5" strokeWidth="1" />

          {/* links */}
          <g>
            {ordered.map((n) => {
              const pos = layout.get(n.id) as Pos;
              const active = n.state === 'calling';
              const failed = n.state === 'failed';
              const candidate = n.kind === 'candidate';
              return (
                <g key={`${n.id}-${candidate ? 'c' : 'n'}`}>
                  <path
                    ref={(el) => {
                      if (el) paths.current.set(n.id, el);
                      else paths.current.delete(n.id);
                    }}
                    d={linkPath(pos, hashBend(n.id))}
                    pathLength={1}
                    fill="none"
                    stroke={failed ? '#fb7185' : active ? '#8b5cf6' : n.uses > 0 ? '#a78bfa' : '#d4d4d8'}
                    strokeWidth={active ? 2 : candidate ? 1 : 1.4}
                    strokeOpacity={candidate ? 0.8 : 1}
                    strokeDasharray={candidate ? '0.012 0.02' : undefined}
                    strokeLinecap="round"
                    className={candidate ? undefined : 'sn-draw'}
                    style={{ transition: 'stroke 400ms, stroke-width 400ms' }}
                  />
                </g>
              );
            })}
          </g>

          {/* the agent */}
          <g>
            <circle cx={CX} cy={CY} r={100} fill="url(#sn-glow-c)" className="sn-breathe sn-box" />
            {searching
              ? [0, 0.75, 1.5].map((d) => <circle key={d} cx={CX} cy={CY} r={120} fill="none" stroke="#8b5cf6" strokeOpacity="0.45" strokeWidth="1.2" className="sn-ping sn-box" style={{ animationDelay: `${d}s` }} />)
              : null}
            {running && !asking ? (
              <g transform={`translate(${CX} ${CY})`} opacity={searching ? 1 : 0.45} style={{ transition: 'opacity 500ms' }}>
                <g className="sn-sweep" style={{ transformBox: 'fill-box', transformOrigin: '0 0' }}>
                  <path d="M 0 0 L 150 0 A 150 150 0 0 1 114.9 96.4 Z" fill="url(#sn-sweep)" />
                  <line x1="0" y1="0" x2="150" y2="0" stroke="#8b5cf6" strokeOpacity="0.6" strokeWidth="1.2" />
                </g>
              </g>
            ) : null}
            <circle cx={CX} cy={CY} r={RADIUS} fill="#ffffff" stroke="#e4e4e7" strokeWidth="7" />
            <circle
              cx={CX}
              cy={CY}
              r={RADIUS}
              fill="none"
              stroke="url(#sn-arc)"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={`${(CIRCUMFERENCE * fraction).toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`}
              transform={`rotate(-90 ${CX} ${CY})`}
              style={{ transition: 'stroke-dasharray 1100ms cubic-bezier(0.22, 1, 0.36, 1)' }}
            />
            <circle cx={CX} cy={CY} r={RADIUS - 8} fill="#fafafa" stroke="#e4e4e7" strokeWidth="1" />
            <text x={CX} y={CY - 14} textAnchor="middle" fill="#71717a" fontSize="8" letterSpacing="1.5" style={{ textTransform: 'uppercase' }}>
              {copy.network.you}
            </text>
            <Counter usd={creditUsd} reduced={reduced} />
            <text x={CX} y={CY + 22} textAnchor="middle" fill="#71717a" fontSize="8.5">
              {copy.network.creditLeft}
            </text>
          </g>

          {/* light running along the links */}
          <g ref={layer} />

          {/* found: a ring opens where each new agent appears */}
          {bursts.map((b) => {
            const pos = layout.get(b.id);
            return pos ? <circle key={b.key} cx={pos.x} cy={pos.y} r={30} fill="none" stroke="#8b5cf6" strokeWidth="1.5" className="sn-burst sn-box" /> : null;
          })}

          {/* the cards */}
          {ordered.map((n) => {
            const pos = layout.get(n.id) as Pos;
            const chip = n.kind === 'candidate';
            const w = chip ? 116 : 150;
            const h = chip ? 28 : 50;
            return (
              <g key={n.id} style={{ transform: `translate(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px)`, transition: 'transform 900ms cubic-bezier(0.22, 1, 0.36, 1)' }}>
                <g className="sn-pop sn-box">
                  <foreignObject x={-w / 2} y={-h / 2} width={w} height={h} style={{ overflow: 'visible' }}>
                    {chip ? <Chip node={n} /> : <Card node={n} />}
                  </foreignObject>
                </g>
              </g>
            );
          })}

          {/* amounts that float up from whoever was just paid */}
          {tags.map((t) => {
            const pos = layout.get(t.id);
            if (!pos) return null;
            return (
              <g key={t.key} transform={`translate(${pos.x.toFixed(1)} ${(pos.y - 36).toFixed(1)})`}>
                <foreignObject x={-80} y={-14} width={160} height={28} style={{ overflow: 'visible' }}>
                  <div className="sn-float flex h-full items-center justify-center">
                    <span
                      className={cn(
                        'max-w-full truncate rounded-full px-2.5 py-0.5 text-[11px] font-semibold tabular-nums shadow-sm ring-1',
                        t.tone === 'paid' ? 'bg-amber-100 text-amber-800 ring-amber-300' : 'bg-rose-100 text-rose-800 ring-rose-300',
                      )}
                    >
                      {t.text}
                    </span>
                  </div>
                </foreignObject>
              </g>
            );
          })}
        </svg>

        {nodes.length === 0 ? <p className="absolute inset-x-0 bottom-6 px-6 text-center text-xs text-muted-foreground">{copy.network.empty}</p> : null}
      </div>

      <footer className="relative z-10 min-h-9 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        <p className="truncate" aria-hidden>
          {log.length ? log[log.length - 1] : copy.network.empty}
        </p>
        <ol className="sr-only" aria-live="polite" aria-label={copy.network.log}>
          {log.map((l, i) => (
            <li key={`${i}-${l}`}>{l}</li>
          ))}
        </ol>
      </footer>
    </section>
  );
}

// S6: what an agent did on the network while it answered, and the picture of it. Plain data and pure functions, shared
// by the server (which reads it out of a run) and the browser (which draws it). No server-only code in here.

export type CallKind = 'search' | 'hire' | 'helper' | 'source' | 'web';
export type CallState = 'calling' | 'done' | 'failed';

/** An agent a search turned up. */
export interface FoundAgent {
  entityId: string;
  name: string;
  what: string;
  /** Price per use, a decimal string, when its card could be read. */
  priceUsd?: string;
  /** Where its card is. Server only: removed before anything is sent to the browser. */
  url?: string;
}

/** One use of one of the agent's steps during a run, as the picture needs it. */
export interface NetCall {
  /** Stable while the run goes on: the step's name and which use of it this is. */
  id: string;
  kind: CallKind;
  /** The step's name. */
  tool: string;
  state: CallState;
  /** search: the words the AI searched for. */
  query?: string;
  /** search: who came back. */
  found?: FoundAgent[];
  /** hire / helper: who was asked (an entity id). */
  agentId?: string;
  /** Who it was, readable, when known. */
  name?: string;
  /** What one use costs, a decimal string, when known. */
  priceUsd?: string;
  /** What this use cost once it is done. */
  paidUsd?: string;
}

/** A finished use, kept with the chat turn so the picture can be drawn again after a reload. */
export interface SavedCall {
  kind: Exclude<CallKind, 'search'>;
  tool: string;
  ok: boolean;
  agentId?: string;
  name?: string;
  priceUsd?: string;
  paidUsd?: string;
}

/** The steps the agent has, as the picture lists them before anything happens. */
export interface ToolView {
  name: string;
  kind: 'helper' | 'source' | 'web';
  priceUsd?: string;
  what?: string;
}

export const MICRO = 1_000_000;

/** "0.050000" -> 50000. Anything that is not a plain decimal is 0. */
export function toMicros(v: string | number | undefined | null): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * MICRO) : 0;
}

export const fromMicros = (n: number): string => (Math.max(0, n) / MICRO).toFixed(6);

/** The picture's id for the thing a call was made to: one per agent hired, one per step of the agent's own. */
export const nodeIdOf = (c: Pick<NetCall, 'kind' | 'tool' | 'agentId'>): string => (c.kind === 'hire' ? `agent:${c.agentId ?? c.tool}` : `tool:${c.tool}`);

/** What a chat turn remembers of a run: only the finished uses of agents and tools. */
export function saveCalls(calls: readonly NetCall[]): SavedCall[] {
  const out: SavedCall[] = [];
  for (const c of calls) {
    if (c.kind === 'search' || c.state === 'calling') continue;
    out.push({
      kind: c.kind,
      tool: c.tool,
      ok: c.state === 'done',
      ...(c.agentId ? { agentId: c.agentId } : {}),
      ...(c.name ? { name: c.name } : {}),
      ...(c.priceUsd ? { priceUsd: c.priceUsd } : {}),
      ...(c.paidUsd ? { paidUsd: c.paidUsd } : {}),
    });
  }
  return out.slice(0, 12);
}

export type NodeKind = 'helper' | 'source' | 'web' | 'agent' | 'candidate';
export type NodeState = 'idle' | 'calling' | 'failed';

/** One thing in the picture besides the agent itself. */
export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  what?: string;
  /** Price per use, a decimal string. */
  priceUsd?: string;
  /** Paid to it in this conversation, in millionths of a dollar. */
  paidMicros: number;
  uses: number;
  state: NodeState;
}

const clean = (s: string | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const shortId = (id: string) => `Agent ${id.replace(/^zns:/, '').slice(0, 6)}`;

/**
 * The picture of one conversation: the agent's own tools from the start (quiet until used), every agent it hired, and
 * while a run is going the agents a search turned up that have not been hired (candidates).
 * `history` is the finished uses of earlier answers; `live` is the run in progress or just finished.
 */
export function buildGraph(input: { tools: readonly ToolView[]; history: readonly SavedCall[]; live: readonly NetCall[] }): GraphNode[] {
  const nodes = new Map<string, GraphNode>();
  const order: string[] = [];
  const put = (n: GraphNode) => {
    if (!nodes.has(n.id)) order.push(n.id);
    nodes.set(n.id, n);
    return n;
  };
  for (const t of input.tools) {
    put({ id: `tool:${t.name}`, kind: t.kind, label: clean(t.name, 40), ...(t.what ? { what: clean(t.what, 100) } : {}), ...(t.priceUsd ? { priceUsd: t.priceUsd } : {}), paidMicros: 0, uses: 0, state: 'idle' });
  }

  const node = (kind: Exclude<CallKind, 'search'>, tool: string, agentId?: string, name?: string, priceUsd?: string): GraphNode => {
    const id = kind === 'hire' ? `agent:${agentId ?? tool}` : `tool:${tool}`;
    const have = nodes.get(id);
    if (have) {
      if (name && (have.kind === 'agent' || have.kind === 'candidate') && have.label.startsWith('Agent ')) have.label = clean(name, 40);
      if (priceUsd && !have.priceUsd) have.priceUsd = priceUsd;
      if (have.kind === 'candidate') have.kind = 'agent';
      return have;
    }
    const kindOut: NodeKind = kind === 'hire' ? 'agent' : kind;
    return put({ id, kind: kindOut, label: clean(name ?? (agentId ? shortId(agentId) : tool), 40), ...(priceUsd ? { priceUsd } : {}), paidMicros: 0, uses: 0, state: 'idle' });
  };

  for (const c of input.history) {
    const n = node(c.kind, c.tool, c.agentId, c.name, c.priceUsd);
    n.uses += 1;
    if (c.ok) n.paidMicros += toMicros(c.paidUsd);
  }

  // Names of agents the live run's searches found, so a hire shows a name even when its card could not be read.
  const found = new Map<string, FoundAgent>();
  for (const c of input.live) for (const f of c.found ?? []) found.set(f.entityId, f);
  const hired = new Set(input.live.filter((c) => c.kind === 'hire' && c.agentId).map((c) => c.agentId as string));

  for (const c of input.live) {
    if (c.kind === 'search') continue;
    const f = c.agentId ? found.get(c.agentId) : undefined;
    const n = node(c.kind, c.tool, c.agentId, c.name ?? f?.name, c.priceUsd ?? f?.priceUsd);
    if (c.state === 'calling') n.state = 'calling';
    else {
      n.uses += 1;
      n.state = c.state === 'failed' ? 'failed' : 'idle';
      if (c.state === 'done') n.paidMicros += toMicros(c.paidUsd);
    }
  }
  for (const c of input.live) {
    if (c.kind !== 'search') continue;
    for (const f of c.found ?? []) {
      if (hired.has(f.entityId) || nodes.has(`agent:${f.entityId}`)) continue;
      put({ id: `agent:${f.entityId}`, kind: 'candidate', label: clean(f.name, 40) || shortId(f.entityId), what: clean(f.what, 100), ...(f.priceUsd ? { priceUsd: f.priceUsd } : {}), paidMicros: 0, uses: 0, state: 'idle' });
    }
  }
  return order.map((id) => nodes.get(id) as GraphNode);
}

/** What the agent has spent in this conversation, in millionths of a dollar. */
export const totalPaidMicros = (nodes: readonly GraphNode[]): number => nodes.reduce((sum, n) => sum + n.paidMicros, 0);

/** The agent's tools as the picture lists them, from the setup the server read. */
export function toolViews(tools: readonly { name: string; kind: string; maxPriceUsd?: string; what?: string }[]): ToolView[] {
  return tools.flatMap((t): ToolView[] => {
    const kind = t.kind === 'data source' ? 'source' : t.kind === 'helper' || t.kind === 'web' ? t.kind : null;
    return kind ? [{ name: t.name, kind, ...(t.maxPriceUsd ? { priceUsd: t.maxPriceUsd } : {}), ...(t.what ? { what: t.what } : {}) }] : [];
  });
}

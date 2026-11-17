// What the builder streams to the browser, one JSON object per line. Shared by the server route and the Create agent
// screen, so it holds types and tiny pure helpers only (no server imports).
import type { Helper } from '../types';

export type BuildStep = 'finding' | 'building' | 'testing' | 'ready';
export const BUILD_STEPS: readonly BuildStep[] = ['finding', 'building', 'testing', 'ready'];

/** The live preview card. */
export interface Preview {
  name: string;
  does: string;
  /** Other agents and data sources the agent uses, each with its price. */
  helpers: Helper[];
  /** About what one use costs in helpers, a decimal string. */
  costUsd: string;
  /** What Studio suggests charging other agents per use. */
  suggestedPriceUsd: string;
}

export type LiveState = 'updated' | 'held' | 'failed';

/** One part of the agent as the person sees it being built (S5.3). Plain kinds, no technical names. */
export type PartKind = 'network' | 'chat' | 'request' | 'brain' | 'helper' | 'source' | 'web' | 'answer';
export type PartState = 'planned' | 'building' | 'ready' | 'testing' | 'used' | 'failed';
export interface Part {
  id: string;
  kind: PartKind;
  /** A tool's name, or what the agent does (for the brain). */
  label?: string;
  detail?: string;
  /** The most one use of a paid tool may cost. */
  priceUsd?: string;
  /** What it cost in the last test. */
  costUsd?: string;
  state: PartState;
}

/** One line of what the builder is doing, in plain words. Sent again with the same id when it finishes. */
export interface Activity {
  id: string;
  label: string;
  state: 'running' | 'done' | 'failed';
}

export type BuildEvent =
  | { type: 'text'; delta: string }
  | { type: 'preview'; preview: Preview }
  | { type: 'progress'; step: BuildStep }
  /**
   * What happened to a live agent's change once the message ended: `updated` (tested, now running), `held` (not
   * tested, so the agent still runs its earlier version) or `failed` (could not be put live; same earlier version
   * unless n8n says otherwise).
   */
  | { type: 'live'; state: LiveState }
  /** The token to send with the next message so the conversation continues. */
  | { type: 'thread'; token: string }
  | { type: 'done' }
  /** Plain words, with a next step. Never raw error text. */
  | { type: 'error'; message: string }
  /** The agent's parts and their state, whole each time (S5.3). */
  | { type: 'blueprint'; parts: Part[] }
  | { type: 'activity'; activity: Activity }
  /** Keeps a quiet stream open through proxies. Carries nothing. */
  | { type: 'ping' };

/** An event as a background job numbers it (S5.2): a reconnecting screen asks for everything after the last `seq`. */
export type Numbered = BuildEvent & { seq: number };

/** One builder message as a background job (S5.2). The same view is built on the server and in the browser. */
export interface BuildView {
  /** The job's id: a screen that already showed this job does not show it twice. */
  id: string;
  status: 'running' | 'done' | 'error';
  /** What the person asked. */
  message: string;
  /** The builder's reply so far. */
  reply: string;
  preview?: Preview;
  /** 0 not started; 1..4 = the step in progress; 5 = ready. */
  step: number;
  live?: LiveState;
  error?: string;
  thread?: string;
  /** The agent's parts as last shown, and what the builder did, newest last. */
  parts: Part[];
  activity: Activity[];
  /** The last event applied. */
  seq: number;
  startedAt: number;
}

const ACTIVITY_KEEP = 40;

export const newView = (id: string, message: string, startedAt: number): BuildView => ({ id, status: 'running', message, reply: '', step: 0, parts: [], activity: [], seq: 0, startedAt });

/** The line the builder is on now: the newest one still running. */
export const currentActivity = (v: BuildView): Activity | undefined => [...v.activity].reverse().find((a) => a.state === 'running');

/** Applies one event. Pure: the server keeps its view this way and the browser rebuilds the same one. */
export function applyEvent(view: BuildView, e: BuildEvent | Numbered): BuildView {
  const next: BuildView = { ...view, ...('seq' in e && typeof e.seq === 'number' ? { seq: e.seq } : {}) };
  switch (e.type) {
    case 'text':
      next.reply += e.delta;
      break;
    case 'preview':
      next.preview = e.preview;
      break;
    case 'progress':
      next.step = e.step === 'ready' ? 5 : BUILD_STEPS.indexOf(e.step) + 1;
      break;
    case 'live':
      next.live = e.state;
      break;
    case 'thread':
      next.thread = e.token;
      break;
    case 'blueprint':
      next.parts = e.parts;
      break;
    case 'activity': {
      const at = view.activity.findIndex((a) => a.id === e.activity.id);
      next.activity = at >= 0 ? view.activity.map((a, i) => (i === at ? e.activity : a)) : [...view.activity, e.activity].slice(-ACTIVITY_KEEP);
      break;
    }
    case 'done':
      next.status = 'done';
      next.activity = next.activity.map((a) => (a.state === 'running' ? { ...a, state: 'done' } : a));
      break;
    case 'error':
      next.status = 'error';
      next.error = e.message;
      // Nothing is still going on once it has ended.
      next.activity = next.activity.map((a) => (a.state === 'running' ? { ...a, state: 'failed' } : a));
      break;
    default:
      break;
  }
  return next;
}

/** A stream of newline-separated JSON events, as the server writes it. */
export const encodeEvent = (e: BuildEvent | Numbered): string => `${JSON.stringify(e)}\n`;

/** Pulls whole events out of a chunked stream. Keep the returned `rest` for the next chunk. */
export function decodeEvents(buffer: string): { events: (BuildEvent & { seq?: number })[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const events: (BuildEvent & { seq?: number })[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as BuildEvent;
      if (e && typeof e === 'object' && typeof (e as { type?: unknown }).type === 'string') events.push(e);
    } catch {
      /* a damaged line is skipped, never shown */
    }
  }
  return { events, rest };
}

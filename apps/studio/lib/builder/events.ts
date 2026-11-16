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
  | { type: 'error'; message: string };

/** A stream of newline-separated JSON events, as the server writes it. */
export const encodeEvent = (e: BuildEvent): string => `${JSON.stringify(e)}\n`;

/** Pulls whole events out of a chunked stream. Keep the returned `rest` for the next chunk. */
export function decodeEvents(buffer: string): { events: BuildEvent[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const events: BuildEvent[] = [];
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

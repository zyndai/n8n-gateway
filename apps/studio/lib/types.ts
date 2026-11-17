import type { SavedCall } from './network';

export type AgentStatus = 'draft' | 'live' | 'paused';

export interface Helper {
  name: string;
  /** What the helper does, in a few words. */
  what: string;
  /** Price per use as a decimal string, e.g. "0.05". */
  priceUsd: string;
}

/** What the UI knows about an agent. Built from a Gateway listing, or from sample data in preview. */
export interface Agent {
  id: string;
  name: string;
  /** One line on what it does. */
  summary: string;
  status: AgentStatus;
  /** Credit left, a decimal string, or null when it could not be read. */
  creditUsd: string | null;
  earnedUsd: string;
  /** Price per use for other agents, a decimal string, or null for the default. */
  priceUsd: string | null;
  helpers: Helper[];
  /** The agent has been built (it has a workflow), so it can be tried and published. */
  hasWorkflow: boolean;
  createdAt: string;
}

export interface ChatTurn {
  role: 'user' | 'agent';
  text: string;
  /** Helpers used and cost for an agent answer. */
  used?: { helpers: number; costUsd: string };
  /** Technical lines behind the Details toggle. */
  details?: string[];
  /** S6: what this answer used on the network, kept so the picture can be drawn again after a reload. */
  net?: SavedCall[];
}

export interface ActivityItem {
  id: string;
  kind: 'you' | 'other';
  at: string;
  ok: boolean;
  /** Money earned (other) or spent (you), decimal string. */
  amountUsd: string;
  title: string;
}

/** The signed-in person, as the UI sees them. */
export interface Viewer {
  name: string;
  email: string;
  handle: string;
}

/** How the app's live features run: scripted sample data (preview), the real thing (live), or not switched on (off). */
export type BuilderMode = 'preview' | 'live' | 'off';

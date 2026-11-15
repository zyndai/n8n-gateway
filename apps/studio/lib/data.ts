import 'server-only';
import { cache } from 'react';
import { isPreview, studioEnv } from './env';
import { createGatewayClient, type ListingView, type WalletView } from './gateway/client';
import { sumUsd } from './format';
import { SAMPLE_ACTIVITY, SAMPLE_AGENTS, SAMPLE_CHAT } from './sample';
import type { StudioSession } from './session-cookie';
import { STUDIO_TAG, agentStatus } from './status';
import type { ActivityItem, Agent, ChatTurn } from './types';

const gatewayFor = (s: StudioSession) => {
  const env = studioEnv();
  return createGatewayClient({ baseUrl: env.gatewayUrl, sessionSecret: env.sessionJwtSecret, serviceToken: env.serviceToken }).as(s.did);
};

/** A Gateway listing as the UI shows an agent. Credit and earnings are filled in by the caller when known. */
export function toAgent(l: ListingView, wallet?: WalletView, earnings?: Map<string, string>): Agent {
  const w = wallet?.listings.find((x) => x.listingId === l.id);
  return {
    id: l.id,
    name: l.name,
    summary: l.summary,
    status: agentStatus(l.status),
    creditUsd: w ? w.balanceUsd : null,
    earnedUsd: earnings?.get(l.id) ?? '0',
    priceUsd: l.priceUsd,
    helpers: [],
    hasWorkflow: Boolean(l.workflowId),
    createdAt: l.createdAt,
  };
}

export const isStudioListing = (l: ListingView) => l.tags.includes(STUDIO_TAG);

/** The person's agents: Gateway listings tagged `zynd-studio`, with their credit from the wallet read. */
export const listAgents = cache(async (s: StudioSession): Promise<Agent[]> => {
  if (isPreview()) return SAMPLE_AGENTS;
  const api = gatewayFor(s);
  const listings = (await api.listListings()).filter(isStudioListing);
  if (listings.length === 0) return [];
  // The chain can be slow or down: agents still show, with credit (or earnings) unknown.
  const [wallet, totals] = await Promise.all([api.wallet().catch(() => undefined), api.analytics({ days: 365 }).catch(() => undefined)]);
  const earnings = totals ? new Map(totals.filter((t) => t.listingId).map((t) => [t.listingId as string, t.revenueUsd])) : undefined;
  return listings.map((l) => toAgent(l, wallet, earnings)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});

export async function getAgent(s: StudioSession, id: string): Promise<Agent | null> {
  return (await listAgents(s)).find((a) => a.id === id) ?? null;
}

/** Total credit across the person's agents, or null when it could not be read. */
export const totalCredit = cache(async (s: StudioSession): Promise<string | null> => {
  if (isPreview()) return sumUsd(SAMPLE_AGENTS.map((a) => a.creditUsd));
  try {
    return sumUsd((await listAgents(s)).map((a) => a.creditUsd));
  } catch {
    return null;
  }
});

export const sampleChat = (): ChatTurn[] => SAMPLE_CHAT;
export const sampleActivity = (): ActivityItem[] => SAMPLE_ACTIVITY;

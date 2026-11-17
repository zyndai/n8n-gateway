// What a person can do with their agents (plan, "Flows" 2 to 6), as one class with its dependencies passed in so
// every step can be tested against fakes. The developer id always comes from Studio's checked session; an agent id
// from a request is only ever looked up in that developer's own listings, and only those tagged `zynd-studio`.
import { GatewayError, type DeveloperApi, type GatewayClient, type ListingView, type WalletView } from '../gateway/client';
import { type StarterOutcome, type Treasury, sendStarterCredit } from '../credit/starter';
import type { DataSource } from '../env';
import type { PolicyContext } from '../n8n/policy';
import { McpError } from '../n8n/mcp';
import { RelayRefusal, WorkflowRelay, type McpLike } from '../n8n/relay';
import type { RunView } from '../n8n/runs';
import type { ActivityItem } from '../types';
import type { StudioSession } from '../session-cookie';
import { credentialName } from '../setup';
import { STUDIO_TAG } from '../status';

export type AgentErrorCode =
  | 'not-found'
  | 'limit'
  | 'bad-input'
  | 'no-workflow'
  | 'not-ready'
  | 'not-live'
  | 'registration'
  | 'unavailable';

/** A refusal with a code the UI turns into plain words. The message is for logs. */
export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export interface AgentServiceDeps {
  gateway: GatewayClient;
  mcp: McpLike;
  /** The id of a credential in n8n by exact name and type. */
  findCredentialId(type: string, name: string): Promise<string | undefined>;
  treasury: Treasury | null;
  starterCreditUsd: string;
  starterCreditMaxAgents: number;
  openAiCredentialId: string;
  /** The platform OpenAI credential's name in n8n. Optional: without it Studio sets the credential by id only. */
  openAiCredentialName?: () => Promise<string>;
  agentModel: string;
  dataSources: DataSource[];
  maxCallPriceUsd: string;
  /** The most agents one person may have. */
  maxAgents?: number;
  log?: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
}

export const DEFAULT_AGENT_NAME = 'New agent';
export const DEFAULT_SUMMARY = 'An agent built with Zynd Studio.';
export const DEFAULT_CATEGORY = 'general';
export const MAX_AGENTS = 10;
export const MESSAGE_MAX = 4000;
export const NAME_MAX = 100;
export const SUMMARY_MAX = 200;
const USD = /^\d{1,3}(\.\d{1,6})?$/;
const CREDIT_COOLDOWN_MS = 30_000;

/** One person's earlier turns, sent along so a follow-up question makes sense. */
export interface ChatTurnIn {
  role: 'user' | 'agent';
  text: string;
}

const MESSAGE_MARKER = 'New message from the user:\n';

/** The request text for one chat run: the new message, with the last few turns before it. */
export function composeRequest(message: string, history: ChatTurnIn[] = []): string {
  const prior = history
    .slice(-4)
    .map((t) => `${t.role === 'user' ? 'User' : 'You'}: ${String(t.text).slice(0, 600)}`)
    .join('\n');
  return prior ? `Earlier in this chat:\n${prior}\n\n${MESSAGE_MARKER}${message}` : message;
}

/** The person's own words out of a composed request (the part after the earlier turns). */
export const lastMessage = (request: string): string => (request.includes(MESSAGE_MARKER) ? request.slice(request.lastIndexOf(MESSAGE_MARKER) + MESSAGE_MARKER.length) : request).trim();

const lastCredit = new Map<string, number>();

export interface CreatedAgent {
  id: string;
  credit: StarterOutcome;
}

export class AgentService {
  private readonly api: DeveloperApi;
  private readonly now: () => number;

  constructor(
    private readonly deps: AgentServiceDeps,
    readonly session: StudioSession,
  ) {
    this.api = deps.gateway.as(session.did);
    this.now = deps.now ?? Date.now;
  }

  /** The person's own Studio agent, or a not-found. Anything else (another developer's, or a dashboard listing) is the same not-found. */
  async load(id: string): Promise<ListingView> {
    let listing: ListingView;
    try {
      listing = await this.api.getListing(id);
    } catch (err) {
      if (err instanceof GatewayError && (err.status === 404 || err.status === 400)) throw new AgentError('not-found', 'No such agent');
      throw err;
    }
    if (!listing.tags.includes(STUDIO_TAG)) throw new AgentError('not-found', 'No such agent');
    return listing;
  }

  /** S2.1: a draft agent with its own wallet, and starter credit when it is due. */
  async create(): Promise<CreatedAgent> {
    const mine = (await this.api.listListings()).filter((l) => l.tags.includes(STUDIO_TAG));
    if (mine.length >= (this.deps.maxAgents ?? MAX_AGENTS)) throw new AgentError('limit', `At most ${this.deps.maxAgents ?? MAX_AGENTS} agents`);
    const listing = await this.api.createListing({ name: DEFAULT_AGENT_NAME, summary: DEFAULT_SUMMARY, category: DEFAULT_CATEGORY, tags: [STUDIO_TAG] });

    let wallet: WalletView | undefined;
    try {
      wallet = await this.api.wallet();
    } catch {
      /* chain or Gateway slow: the agent exists, credit is skipped below */
    }
    const address = wallet?.listings.find((w) => w.listingId === listing.id)?.address;

    const last = lastCredit.get(this.session.uid);
    const tooSoon = last !== undefined && this.now() - last < CREDIT_COOLDOWN_MS;
    const credit: StarterOutcome = tooSoon
      ? { status: 'skipped', reason: 'limit' }
      : await sendStarterCredit({
          treasury: this.deps.treasury,
          amountUsd: this.deps.starterCreditUsd,
          maxAgents: this.deps.starterCreditMaxAgents,
          agentNumber: mine.length + 1,
          walletAddress: address,
          ...(this.deps.log ? { log: this.deps.log } : {}),
        });
    if (credit.status === 'sent') lastCredit.set(this.session.uid, this.now());
    return { id: listing.id, credit };
  }

  /** The guarded relay for one agent: its policy knows the person's credential and this agent's listing. */
  async relayFor(listing: ListingView): Promise<WorkflowRelay> {
    const ctx = await this.policyContextFor(listing);
    const binding = {
      workflowId: listing.workflowId,
      remember: async (workflowId: string) => {
        await this.api.updateListing(listing.id, { workflowId });
      },
      workflowName: () => `${listing.name} · ${listing.id.slice(0, 8)}`,
    };
    return new WorkflowRelay(this.deps.mcp, binding, ctx);
  }

  async policyContextFor(listing: ListingView): Promise<PolicyContext> {
    const zyndCredentialName = credentialName(this.session.handle);
    const zyndCredentialId = await this.deps.findCredentialId('zyndApi', zyndCredentialName);
    if (!zyndCredentialId) throw new AgentError('unavailable', 'The person has no Zynd credential in n8n');
    const openAiCredentialName = await this.deps.openAiCredentialName?.().catch(() => undefined);
    return {
      listingId: listing.id,
      zyndCredentialId,
      zyndCredentialName,
      openAiCredentialId: this.deps.openAiCredentialId,
      ...(openAiCredentialName ? { openAiCredentialName } : {}),
      agentModel: this.deps.agentModel,
      dataSources: this.deps.dataSources,
      maxCallPriceUsd: this.deps.maxCallPriceUsd,
    };
  }

  // --- S3.1: use it in the app ---------------------------------------------------------------

  /** Starts one chat run. A live agent runs its published version; anything else runs the draft. */
  async startChat(id: string, message: string, history: ChatTurnIn[] = []): Promise<{ executionId: string; mode: 'manual' | 'production' }> {
    const text = message.trim();
    if (!text || text.length > MESSAGE_MAX) throw new AgentError('bad-input', 'The message is empty or too long');
    const listing = await this.load(id);
    if (!listing.workflowId) throw new AgentError('no-workflow', 'This agent has not been built yet');
    const relay = await this.relayFor(listing);
    const request = composeRequest(text, history);
    const mode = listing.status === 'ACTIVE' ? 'production' : 'manual';
    try {
      return { executionId: await relay.startRun(request, mode), mode };
    } catch (err) {
      if (!(err instanceof RelayRefusal)) throw err;
      // A live agent whose workflow was turned off outside Studio still works as a draft.
      if (mode === 'production' && /published|active/i.test(err.message)) return { executionId: await relay.startRun(request, 'manual'), mode: 'manual' };
      if (err.problems.length > 0) throw new AgentError('not-ready', err.message, err.problems);
      throw new AgentError('unavailable', err.message);
    }
  }

  async readChat(id: string, executionId: string): Promise<RunView> {
    if (!/^\d{1,12}$/.test(executionId)) throw new AgentError('bad-input', 'Not a run id');
    const listing = await this.load(id);
    if (!listing.workflowId) throw new AgentError('no-workflow', 'This agent has not been built yet');
    return this.relayOrThrow(listing, (r) => r.readRun(executionId));
  }

  private async relayOrThrow<T>(listing: ListingView, f: (r: WorkflowRelay) => Promise<T>): Promise<T> {
    const relay = await this.relayFor(listing);
    try {
      return await f(relay);
    } catch (err) {
      if (err instanceof RelayRefusal) throw new AgentError(err.problems.length ? 'not-ready' : 'unavailable', err.message, err.problems);
      throw err;
    }
  }

  // --- S3.3 / S3.5: publish, pause, settings, delete -------------------------------------------

  /** Saves the final name, description and price, turns the workflow on and waits for the listing to go live. */
  async publish(id: string, input: { name: string; summary: string; priceUsd: string }): Promise<ListingView> {
    const name = input.name.trim();
    const summary = input.summary.trim();
    const price = input.priceUsd.trim();
    if (!name || name.length > NAME_MAX) throw new AgentError('bad-input', 'The name must be 1 to 100 characters');
    if (!summary || summary.length > SUMMARY_MAX) throw new AgentError('bad-input', 'The description must be 1 to 200 characters');
    if (!USD.test(price)) throw new AgentError('bad-input', 'The price must be an amount in USD');

    const listing = await this.load(id);
    if (!listing.workflowId) throw new AgentError('no-workflow', 'This agent has not been built yet');
    const relay = await this.relayFor(listing);
    // Checked before anything is saved, so a refusal leaves the agent exactly as it was.
    await this.relayOrThrow(listing, (r) => r.assertRunnable());

    await this.api.updateListing(id, { name, summary, priceUsd: price });
    try {
      await relay.publish();
      const live = await this.api.activateListing(id);
      if (live.status !== 'ACTIVE') throw new AgentError('registration', `The listing is ${live.status}, not live`);
      return live;
    } catch (err) {
      // Never leave an agent half-live: turn the workflow back off before reporting.
      await relay.unpublish().catch(() => undefined);
      if (err instanceof AgentError) throw err;
      if (err instanceof RelayRefusal) throw new AgentError(err.problems.length ? 'not-ready' : 'registration', err.message, err.problems);
      if (err instanceof GatewayError || err instanceof McpError) throw new AgentError('registration', err.message);
      throw err;
    }
  }

  /** Live -> paused. A draft has nothing to pause. */
  async pause(id: string): Promise<ListingView> {
    const listing = await this.load(id);
    if (listing.status !== 'ACTIVE') throw new AgentError('not-live', 'This agent is not live');
    if (listing.workflowId) await (await this.relayFor(listing)).unpublish();
    return this.api.deactivateListing(id);
  }

  /** Name, description and price, without going live or offline. */
  async saveSettings(id: string, input: { name?: string; summary?: string; priceUsd?: string | null }): Promise<ListingView> {
    await this.load(id);
    const patch: { name?: string; summary?: string; priceUsd?: string | null } = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name || name.length > NAME_MAX) throw new AgentError('bad-input', 'The name must be 1 to 100 characters');
      patch.name = name;
    }
    if (input.summary !== undefined) {
      const summary = input.summary.trim();
      if (!summary || summary.length > SUMMARY_MAX) throw new AgentError('bad-input', 'The description must be 1 to 200 characters');
      patch.summary = summary;
    }
    if (input.priceUsd !== undefined) {
      if (input.priceUsd !== null && !USD.test(input.priceUsd.trim())) throw new AgentError('bad-input', 'The price must be an amount in USD');
      patch.priceUsd = input.priceUsd === null ? null : input.priceUsd.trim();
    }
    if (Object.keys(patch).length === 0) throw new AgentError('bad-input', 'Nothing to save');
    return this.api.updateListing(id, patch);
  }

  /** Pause if live, archive the workflow, then delete the listing. Any credit left is lost (the dialog says so). */
  async remove(id: string): Promise<void> {
    const listing = await this.load(id);
    if (listing.workflowId) {
      const relay = await this.relayFor(listing);
      if (listing.status === 'ACTIVE') {
        await relay.unpublish();
        await this.api.deactivateListing(id).catch(() => undefined);
      }
      // Already gone from n8n is fine: the aim is that nothing is left behind.
      await relay.archive().catch((err) => this.deps.log?.warn(`delete ${id}: could not archive its workflow: ${(err as Error).message}`));
    }
    await this.api.deleteListing(id);
  }

  // --- S3.4: activity ---------------------------------------------------------------------------

  /** The agent's own tries in the app, and uses by other agents, newest first. */
  async activity(id: string): Promise<ActivityItem[]> {
    const listing = await this.load(id);
    const [tasks, tries] = await Promise.all([
      this.api.listTasks({ listingId: id, direction: 'INBOUND', limit: 20 }).catch(() => []),
      listing.workflowId ? this.relayOrThrow(listing, (r) => r.listRuns(10)).catch(() => []) : Promise.resolve([]),
    ]);
    // Each try is read for its question and cost. A run that cannot be read still shows, in plain words.
    const relay = tries.length > 0 ? await this.relayFor(listing) : null;
    const mine = await Promise.all(
      tries.map(async (t): Promise<ActivityItem> => {
        const run = await relay?.readRun(t.id).catch(() => null);
        return {
          id: `run-${t.id}`,
          kind: 'you',
          at: t.startedAt,
          ok: run ? run.status === 'success' && Boolean(run.answer) : t.status === 'success',
          amountUsd: run?.costUsd ?? '0',
          title: run?.request ? lastMessage(run.request).slice(0, 90) : 'You tried it',
        };
      }),
    );
    const hires = tasks.map(
      (t): ActivityItem => ({ id: `task-${t.id}`, kind: 'other', at: t.createdAt, ok: t.status === 'COMPLETED', amountUsd: t.status === 'COMPLETED' ? (t.paymentUsd ?? '0') : '0', title: 'Hired by another agent' }),
    );
    return [...mine, ...hires].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  /** Earnings of one agent (settled payments of completed inbound calls). */
  async earnings(): Promise<Map<string, string>> {
    const totals = await this.api.analytics({ days: 365 });
    return new Map(totals.filter((t) => t.listingId).map((t) => [t.listingId as string, t.revenueUsd]));
  }

}

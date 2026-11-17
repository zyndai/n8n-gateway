// One builder message, start to finish (S2.2): check it, find the person's agent, give the model its tools, run the
// loop and stream the events. The HTTP route only turns the emitted events into a response body.
import { AgentError, type AgentService } from '../agents/service';
import type { DataSource } from '../env';
import { OpenAIError, type OpenAIClient } from '../openai';
import type { HelperCard } from '../registry';
import type { WorkflowRelay } from '../n8n/relay';
import { credentialName } from '../setup';
import type { BuildEvent } from './events';
import { instructionsFor } from './instructions';
import { plainBuilderError, runBuilder } from './loop';
import { signThread, verifyThread } from './thread';
import { createBuilderTools } from './tools';

export interface BuildDeps {
  agents: Pick<AgentService, 'load' | 'relayFor' | 'saveSettings' | 'session'> & Partial<Pick<AgentService, 'walletBalance'>>;
  registry: { search(query: string, limit?: number): Promise<HelperCard[]>; lookup(entityId: string): HelperCard | undefined };
  openai: Pick<OpenAIClient, 'turn'>;
  builderModel: string;
  dataSources: DataSource[];
  sessionSecret: string;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** Passed to the tools: tests make runs and polling instant. */
  tools?: { pollMs?: number; testTimeoutMs?: number; maxTests?: number; sleep?: (ms: number) => Promise<void> };
  maxTurns?: number;
  now?: () => number;
}

export const BUILD_MESSAGE_MAX = 2000;
const HOURLY_LIMIT = 30;
const busy = new Set<string>();
const recent = new Map<string, number[]>();

/** At most 30 builder messages per person per hour: each can spend real OpenAI money. */
function allowed(uid: string, now: number): boolean {
  const since = now - 3_600_000;
  const times = (recent.get(uid) ?? []).filter((t) => t > since);
  if (times.length >= HOURLY_LIMIT) {
    recent.set(uid, times);
    return false;
  }
  times.push(now);
  recent.set(uid, times);
  return true;
}

/** For tests: forget the in-process limits. */
export function resetBuildLimits(): void {
  busy.clear();
  recent.clear();
}

/**
 * After a message on a live agent: if its saved version is ahead of the running one, publish it when a test has
 * answered since the last change, otherwise leave the running version alone and say so. Never throws.
 */
async function settleLive(
  relay: Pick<WorkflowRelay, 'draftAhead' | 'publish'>,
  state: { changed: boolean; tested: boolean },
  emit: (e: BuildEvent) => void,
  log?: Pick<Console, 'warn' | 'error'>,
): Promise<void> {
  let ahead: boolean | undefined;
  try {
    ahead = await relay.draftAhead();
  } catch (err) {
    log?.warn(`builder: could not tell whether the live agent is behind: ${(err as Error)?.message ?? String(err)}`);
  }
  if (!(ahead ?? state.changed)) return;
  if (!state.tested) return void emit({ type: 'live', state: 'held' });
  try {
    await relay.publish();
    emit({ type: 'live', state: 'updated' });
  } catch (err) {
    log?.error(`builder: could not put a change live: ${(err as Error)?.message ?? String(err)}`);
    emit({ type: 'live', state: 'failed' });
  }
}

/** Runs one message. Never throws: whatever happens ends as an `error` or `done` event. */
export async function runBuild(
  deps: BuildDeps,
  input: { agentId: string; message: unknown; thread?: unknown },
  emit: (e: BuildEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message || message.length > BUILD_MESSAGE_MAX) {
    emit({ type: 'error', message: 'Please write a message of up to 2,000 characters.' });
    return;
  }
  const { session } = deps.agents;
  const key = `${session.uid}:${input.agentId}`;
  if (busy.has(key)) {
    emit({ type: 'error', message: 'Your agent is still being worked on. Please wait a moment.' });
    return;
  }
  if (!allowed(session.uid, (deps.now ?? Date.now)())) {
    emit({ type: 'error', message: 'That is a lot of messages in a short time. Please wait a little before the next one.' });
    return;
  }
  busy.add(key);
  const started = (deps.now ?? Date.now)();
  let tools: ReturnType<typeof createBuilderTools> | undefined;
  let turns = 0;
  let cause: string | undefined;
  try {
    const listing = await deps.agents.load(input.agentId);
    const relay = await deps.agents.relayFor(listing);
    const previous = verifyThread(deps.sessionSecret, session.uid, listing.id, input.thread) ?? undefined;
    const current = { id: listing.id, name: listing.name };

    tools = createBuilderTools({
      listing: current,
      save: (patch) => deps.agents.saveSettings(listing.id, patch),
      relay,
      registry: deps.registry,
      dataSources: deps.dataSources,
      zyndCredentialName: credentialName(session.handle),
      ...(deps.agents.walletBalance ? { balance: () => (deps.agents.walletBalance as AgentService['walletBalance'])(listing.id) } : {}),
      emit,
      ...(deps.log ? { log: deps.log } : {}),
      ...deps.tools,
    });

    const outcome = await runBuilder({
      openai: deps.openai,
      model: deps.builderModel,
      instructions: instructionsFor({ agentName: listing.name, hasWorkflow: Boolean(relay.workflowId), live: listing.status === 'ACTIVE' }),
      tools,
      userText: message,
      ...(previous ? { previousResponseId: previous } : {}),
      emit,
      ...(signal ? { signal } : {}),
      ...(deps.log ? { log: deps.log } : {}),
      ...(deps.maxTurns ? { maxTurns: deps.maxTurns } : {}),
    });
    turns = outcome.turns;
    if (!outcome.finished) cause = 'turn-limit';
    // A live agent runs its published version; a tested change is put live now, an untested one is held back.
    if (listing.status === 'ACTIVE' && relay.workflowId) await settleLive(relay, tools.state(), emit, deps.log);
    // Only a clean end hands back a pointer: an interrupted one may hold tool calls nobody answered.
    if (outcome.responseId) emit({ type: 'thread', token: signThread(deps.sessionSecret, session.uid, listing.id, outcome.responseId) });
    emit({ type: 'done' });
  } catch (err) {
    cause = (err as Error)?.name === 'AbortError' ? 'stopped' : err instanceof OpenAIError ? `openai-${err.kind}` : 'error';
    if ((err as Error)?.name === 'AbortError') return;
    if (err instanceof AgentError && err.code === 'not-found') emit({ type: 'error', message: 'We could not find that agent.' });
    else {
      deps.log?.error(`builder: ${(err as Error)?.message ?? String(err)}`);
      emit({ type: 'error', message: plainBuilderError(err) });
    }
  } finally {
    busy.delete(key);
    // One line per message, so the real success rate can be read from the logs (S5.1).
    const s = tools?.state();
    const outcome = s?.ready ? 'ready' : s?.noCredit ? 'no-credit' : s?.changed || s?.tests ? 'unfinished' : 'talk';
    deps.log?.info?.(
      JSON.stringify({
        event: 'builder.outcome',
        agent: input.agentId,
        outcome,
        ...(cause ?? s?.lastFailure ? { cause: cause ?? s?.lastFailure } : {}),
        turns,
        tests: s?.tests ?? 0,
        repairs: s?.repairs ?? 0,
        seconds: Math.round(((deps.now ?? Date.now)() - started) / 1000),
      }),
    );
  }
}

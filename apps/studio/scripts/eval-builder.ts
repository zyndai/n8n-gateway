// S5.4: the builder eval. Runs every idea in test/fixtures/build-ideas.json through the real builder (OpenAI, n8n,
// the Gateway, the network's helpers) the way the app does, and counts how many reach "ready" with a test answer.
// The goal is at least 27 of 30, twice in a row.
//
// It SPENDS REAL MONEY: OpenAI tokens for the builder and the agents, and helper fees from the eval agent's credit.
// Roughly $3-6 for a full run. Run it only on purpose:
//
//   npm run eval:builder -w apps/studio                  # all 30
//   npm run eval:builder -w apps/studio -- --only h01,e02
//   npm run eval:builder -w apps/studio -- --limit 5
//
// It uses its own Studio account (set up once, like a first sign-in: a developer, a key and an n8n credential) and one
// agent whose wallet holds the starter credit. Between ideas the agent's workflow is archived and unlinked, so each
// idea is built from scratch on the same funded wallet. Results go to apps/studio/.eval/ (not committed).
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentService } from '../lib/agents/service';
import { resetBuildLimits, runBuild, type BuildDeps } from '../lib/builder/build';
import { applyEvent, newView, type BuildEvent, type BuildView } from '../lib/builder/events';
import { createTreasury } from '../lib/credit/starter';
import { builderEnv, creditEnv, studioEnv } from '../lib/env';
import { createGatewayClient } from '../lib/gateway/client';
import { N8nMcp } from '../lib/n8n/mcp';
import { createCredential, restWorkflowWriter } from '../lib/n8n/rest';
import { OpenAIClient } from '../lib/openai';
import { Registry } from '../lib/registry';
import { setupUser } from '../lib/setup';

interface Idea {
  id: string;
  kind: 'plain' | 'helper' | 'web' | 'edit';
  message: string;
  edit?: string;
}

interface Outcome {
  event: 'builder.outcome';
  outcome: string;
  cause?: string;
  turns: number;
  tests: number;
  repairs: number;
  seconds: number;
}

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, '.eval');
const STATE = join(OUT, 'state.json');
const EVAL_USER = { id: 'studio-eval-runner', name: 'Studio Eval', email: 'studio-eval@zynd.invalid' };

function args(): { only?: Set<string>; limit?: number } {
  const a = process.argv.slice(2);
  const only = a.includes('--only') ? new Set(String(a[a.indexOf('--only') + 1] ?? '').split(',').filter(Boolean)) : undefined;
  const limit = a.includes('--limit') ? Number(a[a.indexOf('--limit') + 1]) : undefined;
  return { ...(only ? { only } : {}), ...(limit ? { limit } : {}) };
}

async function main() {
  const env = studioEnv();
  const b = builderEnv();
  const credit = creditEnv();
  const fixture = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/build-ideas.json'), 'utf8')) as { followUp: string; ideas: Idea[] };
  const { only, limit } = args();
  const ideas = fixture.ideas.filter((i) => !only || only.has(i.id)).slice(0, limit ?? Infinity);
  mkdirSync(OUT, { recursive: true });

  const mcp = new N8nMcp({ url: env.n8nMcpUrl, token: env.n8nMcpToken });
  const gateway = createGatewayClient({ baseUrl: env.gatewayUrl, sessionSecret: env.sessionJwtSecret, serviceToken: env.serviceToken });
  const restCfg = { apiUrl: env.n8nApiUrl, apiKey: env.n8nApiKey };
  const openAiCredentialName = async () => {
    const out = (await mcp.callTool('list_credentials', { type: 'openAiApi', limit: 50 })) as { data?: { id: string; name: string }[] } | null;
    const name = out?.data?.find((c) => c.id === b.openAiCredentialId)?.name;
    if (!name) throw new Error('The platform OpenAI credential was not found in n8n');
    return name;
  };

  // The eval's own account, set up exactly like a first sign-in (idempotent).
  const session = await setupUser(
    {
      gateway,
      n8n: { findCredentials: (type, name) => mcp.findCredentials(type, name), createCredential: (body) => createCredential(restCfg, body) },
      gatewayUrlForN8n: env.gatewayUrlForN8n,
      spendCapUsd: env.agentKeySpendCapUsd,
    },
    EVAL_USER,
  );
  const agents = new AgentService(
    {
      gateway,
      mcp,
      workflows: restWorkflowWriter(restCfg),
      findCredentialId: async (type, name) => {
        const found = await mcp.findCredentials(type, name);
        return found.length === 1 ? found[0]?.id : undefined;
      },
      treasury: credit ? createTreasury(credit) : null,
      starterCreditUsd: credit?.amountUsd ?? '0',
      starterCreditMaxAgents: credit?.maxAgents ?? 0,
      openAiCredentialId: b.openAiCredentialId,
      openAiCredentialName,
      agentModel: b.agentModel,
      dataSources: b.dataSources,
      maxCallPriceUsd: b.maxCallPriceUsd,
    },
    session,
  );

  // One funded agent, kept between runs.
  const state = existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as { agentId?: string }) : {};
  let agentId = state.agentId;
  if (agentId) await agents.load(agentId).catch(() => (agentId = undefined));
  if (!agentId) {
    const made = await agents.create();
    agentId = made.id;
    writeFileSync(STATE, JSON.stringify({ agentId }, null, 2));
    console.log(`eval agent ${agentId}: starter credit ${made.credit.status}`);
  }
  console.log(`eval agent ${agentId}, wallet ${(await agents.walletBalance(agentId)) ?? 'unknown'} USD, ${ideas.length} ideas`);

  const api = gateway.as(session.did);
  /** Builds from scratch next time: archive the agent's workflow and unlink it. */
  const reset = async () => {
    const listing = await agents.load(agentId as string);
    if (listing.workflowId) {
      await mcp.callTool('archive_workflow', { workflowId: listing.workflowId }).catch(() => undefined);
      await api.updateListing(listing.id, { workflowId: null });
    }
  };

  const registry = new Registry({ agentDnsUrl: b.agentDnsUrl, maxCallPriceUsd: b.maxCallPriceUsd });
  const openai = new OpenAIClient({ apiKey: b.openAiApiKey });

  /** One message, as the app sends it. Returns the view and the outcome line. */
  const send = async (message: string, thread?: string): Promise<{ view: BuildView; outcome?: Outcome }> => {
    resetBuildLimits();
    let view = newView('eval', message, Date.now());
    let outcome: Outcome | undefined;
    const deps: BuildDeps = {
      agents,
      registry,
      openai,
      builderModel: b.openAiModel,
      dataSources: b.dataSources,
      sessionSecret: env.sessionJwtSecret,
      log: {
        info: (m: string) => {
          try {
            const o = JSON.parse(m) as Outcome;
            if (o.event === 'builder.outcome') outcome = o;
          } catch {
            /* not ours */
          }
        },
        warn: (m: string) => console.warn(`  warn: ${m}`),
        error: (m: string) => console.warn(`  error: ${m}`),
      },
    };
    await runBuild(deps, { agentId: agentId as string, message, ...(thread ? { thread } : {}) }, (e: BuildEvent) => (view = applyEvent(view, e)), AbortSignal.timeout(8 * 60_000));
    return { view, ...(outcome ? { outcome } : {}) };
  };

  const file = join(OUT, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  let passed = 0;
  for (const idea of ideas) {
    const started = Date.now();
    await reset();
    const messages: string[] = [idea.message];
    let r = await send(idea.message);
    // The builder may ask a question first: answer once, as a person would.
    if (r.outcome?.outcome === 'talk' && r.view.thread) {
      messages.push(fixture.followUp);
      r = await send(fixture.followUp, r.view.thread);
    }
    let built = r.outcome?.outcome === 'ready';
    if (idea.kind === 'edit' && built && idea.edit && r.view.thread) {
      messages.push(idea.edit);
      r = await send(idea.edit, r.view.thread);
      built = r.outcome?.outcome === 'ready';
    }
    if (built) passed += 1;
    const row = {
      id: idea.id,
      kind: idea.kind,
      pass: built,
      outcome: r.outcome?.outcome ?? 'none',
      ...(r.outcome?.cause ? { cause: r.outcome.cause } : {}),
      ...(r.view.error ? { error: r.view.error } : {}),
      messages: messages.length,
      turns: r.outcome?.turns ?? 0,
      tests: r.outcome?.tests ?? 0,
      repairs: r.outcome?.repairs ?? 0,
      seconds: Math.round((Date.now() - started) / 1000),
      tools: r.view.parts.filter((p) => p.kind === 'helper' || p.kind === 'source' || p.kind === 'web').map((p) => p.label ?? p.kind),
      reply: r.view.reply.slice(0, 300),
    };
    appendFileSync(file, `${JSON.stringify(row)}\n`);
    console.log(`${built ? 'PASS' : 'FAIL'} ${idea.id} (${idea.kind}) ${row.outcome}${row.cause ? `/${row.cause}` : ''} · ${row.seconds}s · tests ${row.tests} · repairs ${row.repairs}`);
  }
  await reset();
  console.log(`\n${passed} of ${ideas.length} reached ready (${Math.round((100 * passed) / Math.max(1, ideas.length))}%). Results: ${file}`);
  console.log(`wallet left: ${(await agents.walletBalance(agentId)) ?? 'unknown'} USD`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

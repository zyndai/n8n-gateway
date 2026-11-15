import { beforeEach, describe, expect, it } from 'vitest';
import { AgentService } from '@/lib/agents/service';
import { BUILD_MESSAGE_MAX, resetBuildLimits, runBuild, type BuildDeps } from '@/lib/builder/build';
import type { BuildEvent } from '@/lib/builder/events';
import { signThread, verifyThread } from '@/lib/builder/thread';
import { OpenAIError } from '@/lib/openai';
import type { HelperCard } from '@/lib/registry';
import type { StudioSession } from '@/lib/session-cookie';
import { FakeGateway } from './helpers/fakeGateway';
import { FakeMcp, finishedRun } from './helpers/fakeMcp';
import { FakeModel, outputsOf, type Scripted } from './helpers/fakeOpenAI';
import { HELPER_ID, ZYND_CRED, ctx, goodWorkflow } from './helpers/readback';

const SECRET = 'build-test-secret-0123456789abcdef012345';
const CHECK: HelperCard = { entityId: HELPER_ID, name: 'Counterparty Check', what: 'Confirms a UK company exists.', category: 'compliance', priceUsd: '0.05' };
let n = 0;

describe('runBuild', () => {
  let gw: FakeGateway;
  let mcp: FakeMcp;
  let session: StudioSession;
  let events: BuildEvent[];
  let agentId: string;

  const deps = (model: FakeModel, over: Partial<BuildDeps> = {}): BuildDeps => ({
    agents: new AgentService(
      { gateway: gw, mcp, findCredentialId: async () => ZYND_CRED, treasury: null, starterCreditUsd: '1', starterCreditMaxAgents: 3, openAiCredentialId: ctx.openAiCredentialId, agentModel: ctx.agentModel, dataSources: ctx.dataSources, maxCallPriceUsd: ctx.maxCallPriceUsd },
      session,
    ),
    registry: { search: async () => [CHECK], lookup: (id) => (id === CHECK.entityId ? CHECK : undefined) },
    openai: model,
    builderModel: 'gpt-builder',
    agentModel: ctx.agentModel,
    dataSources: ctx.dataSources,
    sessionSecret: SECRET,
    openAiCredentialName: async () => 'OpenAI account',
    tools: { pollMs: 0, sleep: async () => {}, testTimeoutMs: 100 },
    ...over,
  });
  const run = (model: FakeModel, message: unknown = 'Check a new supplier', thread?: unknown, over: Partial<BuildDeps> = {}) =>
    runBuild(deps(model, over), { agentId, message, thread }, (e) => void events.push(e));
  const types = () => events.map((e) => e.type);

  beforeEach(() => {
    resetBuildLimits();
    gw = new FakeGateway();
    mcp = new FakeMcp();
    session = { uid: `user-b${++n}`, did: 'zns:dev:ada', handle: 'ada-x7k2', name: 'Ada', email: 'a@example.com' };
    events = [];
    agentId = gw.seed({ tags: ['zynd-studio'], name: 'New agent' }).id;
  });

  it('streams the reply, then hands back a thread token for this person and agent, then finishes', async () => {
    await run(new FakeModel([{ text: 'Hello, tell me more.' }]));
    expect(types()).toEqual(['text', 'text', 'thread', 'done']);
    const token = (events.find((e) => e.type === 'thread') as { token: string }).token;
    expect(verifyThread(SECRET, session.uid, agentId, token)).toBe('resp_1');
    expect(verifyThread(SECRET, 'another-user', agentId, token)).toBeNull();
  });

  it('continues from the thread, and ignores one made for someone else\'s agent', async () => {
    const model = new FakeModel([{ text: 'ok' }, { text: 'ok' }]);
    await run(model, 'next', signThread(SECRET, session.uid, agentId, 'resp_prev'));
    expect(model.requests[0]?.previousResponseId).toBe('resp_prev');
    await run(model, 'next', signThread(SECRET, session.uid, 'some-other-agent', 'resp_stolen'));
    expect(model.requests[1]?.previousResponseId).toBeUndefined();
  });

  it('tells the model where the agent stands: built or not, live or not', async () => {
    const m1 = new FakeModel([{ text: 'x' }]);
    await run(m1);
    expect(m1.requests[0]?.instructions).toContain('no version yet');
    gw.listings[0]!.workflowId = 'wf-1';
    gw.listings[0]!.status = 'ACTIVE';
    mcp.workflow = goodWorkflow();
    const m2 = new FakeModel([{ text: 'x' }]);
    await run(m2);
    expect(m2.requests[0]?.instructions).toContain('live: you are editing it');
  });

  it('builds an agent end to end: preview, workflow, test, ready', async () => {
    const script: Scripted[] = [
      { text: 'Let me look for helpers.', calls: [{ name: 'progress', args: { step: 'finding' } }, { name: 'find_helpers', args: { query: 'company check' } }] },
      { calls: [{ name: 'update_preview', args: { name: 'Supplier Check', description: 'Checks a supplier.', helper_ids: [HELPER_ID], suggested_price_usd: '0.15' } }] },
      { calls: [{ name: 'progress', args: { step: 'building' } }, { name: 'get_template', args: { instructions: 'You check suppliers.', helpers: [{ id: HELPER_ID, input: 'json', fields: 'companyName' }] } }] },
      { calls: [{ name: 'create_workflow_from_code', args: { code: 'export default workflow()' } }] },
      { calls: [{ name: 'test_agent', args: { question: 'Check ACME Ltd' } }] },
      { calls: [{ name: 'progress', args: { step: 'ready' } }] },
      { text: 'Your agent is ready: try it and publish when you are happy.' },
    ];
    // The workflow n8n returns for the created agent points at this agent's own listing.
    mcp.created = goodWorkflow((nodes) => {
      for (const node of nodes) {
        if (node.parameters?.listingId) node.parameters.listingId = agentId;
        if (node.parameters?.payFromListingId) node.parameters.payFromListingId = agentId;
      }
    });
    mcp.executions.set('100', finishedRun({ answer: 'ACME is fine.' }));
    const model = new FakeModel(script);
    await run(model);

    expect(events.filter((e) => e.type === 'progress').map((e) => (e as { step: string }).step)).toEqual(['finding', 'building', 'testing', 'ready']);
    expect(events.some((e) => e.type === 'preview')).toBe(true);
    expect(types().slice(-2)).toEqual(['thread', 'done']);
    expect(gw.listings[0]).toMatchObject({ name: 'Supplier Check', summary: 'Checks a supplier.', priceUsd: '0.15', workflowId: 'wf-1' });
    // The model never saw an id it could abuse, and ready came only after the test.
    expect(outputsOf(model.requests[5]?.input ?? [])[0]?.output).toMatchObject({ ok: true, answer: 'ACME is fine.' });
    expect(outputsOf(model.requests[6]?.input ?? [])[0]?.output).toEqual({ shown: 'ready' });
  });

  it('does not let the model say ready without a test', async () => {
    const model = new FakeModel([{ calls: [{ name: 'progress', args: { step: 'ready' } }] }, { text: 'Not yet.' }]);
    await run(model);
    expect(events.some((e) => e.type === 'progress')).toBe(false);
    expect(outputsOf(model.requests[1]?.input ?? [])[0]?.output.error).toMatch(/Not ready yet/);
  });

  it('refuses a message that is empty or too long, without calling the model', async () => {
    const model = new FakeModel([{ text: 'x' }]);
    await run(model, '   ');
    await run(model, 'x'.repeat(BUILD_MESSAGE_MAX + 1));
    await run(model, 42);
    expect(model.requests).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['error', 'error', 'error']);
  });

  it('does not run two messages for one agent at once', async () => {
    let release = () => {};
    const slow = new FakeModel([{ text: 'x' }]);
    const original = slow.turn;
    slow.turn = async (req, onText) => {
      await new Promise<void>((r) => (release = r));
      return original(req, onText);
    };
    const first = run(slow);
    await new Promise((r) => setTimeout(r, 5));
    const second = events.length;
    await run(new FakeModel([{ text: 'y' }]));
    expect(events.slice(second)).toEqual([{ type: 'error', message: expect.stringMatching(/still being worked on/) }]);
    release();
    await first;
    expect(types()).toContain('done');
  });

  it('limits one person to thirty messages an hour', async () => {
    let clock = 1_000_000;
    for (let i = 0; i < 30; i++) await run(new FakeModel([{ text: 'x' }]), 'hello', undefined, { now: () => clock });
    events = [];
    await run(new FakeModel([{ text: 'x' }]), 'hello', undefined, { now: () => clock });
    expect(events).toEqual([{ type: 'error', message: expect.stringMatching(/lot of messages/) }]);
    clock += 3_600_001;
    events = [];
    await run(new FakeModel([{ text: 'x' }]), 'hello', undefined, { now: () => clock });
    expect(types()).toContain('done');
  });

  it('answers in plain words when OpenAI fails, never with the raw message, and gives no thread token', async () => {
    const failing = new FakeModel([{ text: 'x' }]);
    failing.turn = async () => Promise.reject(new OpenAIError('Incorrect API key provided: sk-live-123', 'auth', 401));
    await run(failing);
    expect(events).toEqual([{ type: 'error', message: expect.stringMatching(/not switched on/) }]);
    expect(JSON.stringify(events)).not.toContain('sk-live');
  });

  it('says plainly that an agent that is not found is not found', async () => {
    await runBuild(deps(new FakeModel([])), { agentId: 'someone-elses', message: 'hi' }, (e) => void events.push(e));
    expect(events).toEqual([{ type: 'error', message: 'We could not find that agent.' }]);
  });

  it('can be run again after a failure (the busy lock is released)', async () => {
    const failing = new FakeModel([]);
    failing.turn = async () => Promise.reject(new Error('boom'));
    await run(failing);
    events = [];
    await run(new FakeModel([{ text: 'fine' }]));
    expect(types()).toContain('done');
  });
});

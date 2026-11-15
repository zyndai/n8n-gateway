import { beforeEach, describe, expect, it } from 'vitest';
import { AgentError, AgentService, composeRequest, lastMessage, type AgentServiceDeps } from '@/lib/agents/service';
import type { Treasury } from '@/lib/credit/starter';
import type { StudioSession } from '@/lib/session-cookie';
import { FakeGateway } from './helpers/fakeGateway';
import { FakeMcp, finishedRun } from './helpers/fakeMcp';
import { LISTING_ID, ZYND_CRED, ctx, goodWorkflow } from './helpers/readback';

let uidCounter = 0;
const session = (): StudioSession => ({ uid: `user-${++uidCounter}`, did: 'zns:dev:ada', handle: 'ada-x7k2', name: 'Ada', email: 'ada@example.com' });

describe('AgentService', () => {
  let gw: FakeGateway;
  let mcp: FakeMcp;
  let sent: [string, string][];
  let balance: string;
  let now: number;
  let svc: AgentService;
  let deps: AgentServiceDeps;

  const make = (over: Partial<AgentServiceDeps> = {}, s = session()) => {
    deps = {
      gateway: gw,
      mcp,
      findCredentialId: async () => ZYND_CRED,
      treasury: { balanceUsd: async () => balance, send: async (to, amount) => (sent.push([to, amount]), '0xtx') } satisfies Treasury,
      starterCreditUsd: '1',
      starterCreditMaxAgents: 3,
      openAiCredentialId: ctx.openAiCredentialId,
      agentModel: ctx.agentModel,
      dataSources: ctx.dataSources,
      maxCallPriceUsd: ctx.maxCallPriceUsd,
      now: () => now,
      ...over,
    };
    svc = new AgentService(deps, s);
    return svc;
  };
  /** A Studio agent that has been built: a listing with a workflow, and the workflow in n8n. */
  const builtAgent = (over: Record<string, unknown> = {}) => {
    const l = gw.seed({ tags: ['zynd-studio'], workflowId: 'wf-1', name: 'Supplier Check', ...over });
    mcp.workflow = goodWorkflow((n) => void (n[0] && (n[0].parameters = { listingId: l.id, responseMode: 'lastNode' })));
    // The policy context names this agent's listing in every payment: point the fixture at it.
    for (const n of mcp.workflow.nodes) if (n.parameters?.payFromListingId === LISTING_ID) n.parameters.payFromListingId = l.id;
    return l;
  };
  const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as AgentError).code;

  beforeEach(() => {
    gw = new FakeGateway();
    mcp = new FakeMcp();
    sent = [];
    balance = '50';
    now = 1_000_000;
    make();
  });

  describe('create (S2.1)', () => {
    it('makes a draft tagged zynd-studio with starter credit sent to its own wallet', async () => {
      const out = await svc.create();
      const l = gw.listings[0];
      expect(l).toMatchObject({ id: out.id, name: 'New agent', tags: ['zynd-studio'], status: 'DRAFT', workflowId: null });
      expect(out.credit).toMatchObject({ status: 'sent', amountUsd: '1' });
      expect(sent).toEqual([['0x0000000000000000000000000000000000000001', '1']]);
    });
    it('gives credit only to the first three agents', async () => {
      gw = new FakeGateway();
      const s = session();
      const out: string[] = [];
      for (let i = 0; i < 4; i++) {
        now += 60_000;
        out.push((await make({}, s).create()).credit.status);
      }
      expect(out).toEqual(['sent', 'sent', 'sent', 'skipped']);
    });
    it('still makes the agent when the platform wallet is low, or the chain is down', async () => {
      balance = '0.2';
      expect((await svc.create()).credit).toEqual({ status: 'skipped', reason: 'low-balance' });
      gw.walletFails = true;
      expect((await make().create()).credit).toEqual({ status: 'skipped', reason: 'no-wallet' });
      expect(gw.listings).toHaveLength(2);
    });
    it('does not break when no platform wallet is configured', async () => {
      expect((await make({ treasury: null }).create()).credit).toEqual({ status: 'skipped', reason: 'not-configured' });
    });
    it('does not send credit twice in a row (a double click)', async () => {
      const s = session();
      expect((await make({}, s).create()).credit.status).toBe('sent');
      expect((await make({}, s).create()).credit.status).toBe('skipped');
      expect(sent).toHaveLength(1);
    });
    it('caps how many agents one person can have', async () => {
      for (let i = 0; i < 10; i++) gw.seed({ tags: ['zynd-studio'] });
      expect(await code(svc.create())).toBe('limit');
      expect(gw.listings).toHaveLength(10);
    });
    it('does not count listings the person made on the dashboard', async () => {
      for (let i = 0; i < 12; i++) gw.seed({ tags: [] });
      expect((await svc.create()).id).toBeTruthy();
    });
  });

  describe('load', () => {
    it('only finds the person\'s own Studio agents', async () => {
      const mine = gw.seed({ tags: ['zynd-studio'] });
      const dashboard = gw.seed({ tags: ['compliance'] });
      expect((await svc.load(mine.id)).id).toBe(mine.id);
      expect(await code(svc.load(dashboard.id))).toBe('not-found');
      expect(await code(svc.load('someone-elses'))).toBe('not-found');
    });
    it('always asks the Gateway as the signed-in developer', async () => {
      await svc.load(gw.seed({ tags: ['zynd-studio'] }).id);
      expect(new Set(gw.developers)).toEqual(new Set(['zns:dev:ada']));
    });
  });

  describe('using it in the app (S3.1)', () => {
    it('runs a draft in manual mode and a live agent in production mode', async () => {
      const draft = builtAgent();
      expect((await svc.startChat(draft.id, 'Check ACME')).mode).toBe('manual');
      const live = builtAgent({ status: 'ACTIVE' });
      expect((await svc.startChat(live.id, 'Check ACME')).mode).toBe('production');
      expect(mcp.callsTo('execute_workflow').map((c) => c.args.executionMode)).toEqual(['manual', 'production']);
    });
    it('sends the last few turns along so a follow-up makes sense', async () => {
      const a = builtAgent();
      await svc.startChat(a.id, 'And the wallet?', [{ role: 'user', text: 'Check ACME' }, { role: 'agent', text: 'ACME looks fine.' }]);
      const sentText = (mcp.callsTo('execute_workflow')[0]?.args.inputs as { chatInput: string }).chatInput;
      expect(sentText).toContain('User: Check ACME');
      expect(sentText).toContain('You: ACME looks fine.');
      expect(lastMessage(sentText)).toBe('And the wallet?');
    });
    it('falls back to the draft when a live agent was turned off in n8n', async () => {
      const live = builtAgent({ status: 'ACTIVE' });
      let first = true;
      mcp.executeReply = (args) => {
        if (args.executionMode === 'production' && first) {
          first = false;
          return { executionId: null, status: 'error', error: "Workflow 'wf-1' has no published (active) version to execute" };
        }
        return { executionId: '55', status: 'started' };
      };
      expect(await svc.startChat(live.id, 'Hi')).toEqual({ executionId: '55', mode: 'manual' });
    });
    it('refuses an empty or huge message, an agent with no workflow, and someone else\'s agent', async () => {
      const a = builtAgent();
      expect(await code(svc.startChat(a.id, '   '))).toBe('bad-input');
      expect(await code(svc.startChat(a.id, 'x'.repeat(4001)))).toBe('bad-input');
      expect(await code(svc.startChat(gw.seed({ tags: ['zynd-studio'] }).id, 'hi'))).toBe('no-workflow');
      expect(await code(svc.startChat('nobody', 'hi'))).toBe('not-found');
    });
    it('refuses to run an agent that contains something not allowed', async () => {
      const a = builtAgent();
      mcp.workflow?.nodes.push({ name: 'Run code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {} });
      const err = (await svc.startChat(a.id, 'hi').catch((e: unknown) => e)) as AgentError;
      expect(err.code).toBe('not-ready');
      expect(err.problems.join()).toContain('n8n-nodes-base.code');
      expect(mcp.callsTo('execute_workflow')).toEqual([]);
    });
    it('reads a run, and only its own digits', async () => {
      const a = builtAgent();
      mcp.executions.set('7', finishedRun({ answer: 'Fine.' }));
      expect(await svc.readChat(a.id, '7')).toMatchObject({ status: 'success', answer: 'Fine.' });
      expect(await code(svc.readChat(a.id, '7; drop'))).toBe('bad-input');
      expect(await code(svc.readChat(a.id, '../7'))).toBe('bad-input');
    });
  });

  describe('publish (S3.3)', () => {
    const input = { name: 'Supplier Check', summary: 'Checks a new supplier before you pay.', priceUsd: '0.15' };
    it('saves the final details, turns the workflow on and goes live', async () => {
      const a = builtAgent();
      const live = await svc.publish(a.id, input);
      expect(live.status).toBe('ACTIVE');
      expect(gw.listings[0]).toMatchObject({ name: 'Supplier Check', summary: input.summary, priceUsd: '0.15' });
      expect(gw.calls).toEqual([`update ${a.id} name,summary,priceUsd`, `activate ${a.id}`]);
      expect(mcp.callsTo('publish_workflow')).toHaveLength(1);
    });
    it('checks the workflow before saving anything, so a refusal leaves the agent as it was', async () => {
      const a = builtAgent({ name: 'Original' });
      mcp.workflow?.nodes.push({ name: 'Run code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {} });
      expect(await code(svc.publish(a.id, input))).toBe('not-ready');
      expect(gw.listings[0]?.name).toBe('Original');
      expect(mcp.callsTo('publish_workflow')).toEqual([]);
    });
    it('turns the workflow back off when the network does not take it, never leaving it half-live', async () => {
      const a = builtAgent();
      gw.activateAs = 'ERROR';
      expect(await code(svc.publish(a.id, input))).toBe('registration');
      expect(mcp.callsTo('unpublish_workflow')).toHaveLength(1);
    });
    it('turns the workflow back off when n8n cannot publish it', async () => {
      const a = builtAgent();
      mcp.failTool.publish_workflow = 'n8n refused';
      expect(await code(svc.publish(a.id, input))).toBe('registration');
      expect(mcp.callsTo('unpublish_workflow')).toHaveLength(1);
    });
    it('checks the details: name, 200 characters, a price in dollars', async () => {
      const a = builtAgent();
      for (const bad of [{ ...input, name: ' ' }, { ...input, name: 'x'.repeat(101) }, { ...input, summary: '' }, { ...input, summary: 'x'.repeat(201) }, { ...input, priceUsd: '-1' }, { ...input, priceUsd: 'free' }, { ...input, priceUsd: '1e3' }, { ...input, priceUsd: '1.1234567' }]) {
        expect(await code(svc.publish(a.id, bad))).toBe('bad-input');
      }
      expect(gw.calls).toEqual([]);
    });
    it('needs a built agent', async () => {
      expect(await code(svc.publish(gw.seed({ tags: ['zynd-studio'] }).id, input))).toBe('no-workflow');
    });
  });

  describe('pause, settings and delete (S3.5)', () => {
    it('pauses a live agent: workflow off, listing paused', async () => {
      const a = builtAgent({ status: 'ACTIVE' });
      await svc.pause(a.id);
      expect(mcp.callsTo('unpublish_workflow')).toHaveLength(1);
      expect(gw.listings[0]?.status).toBe('INACTIVE');
    });
    it('has nothing to pause on a draft', async () => {
      expect(await code(svc.pause(builtAgent().id))).toBe('not-live');
    });
    it('saves name, description and price, with the same checks', async () => {
      const a = builtAgent();
      await svc.saveSettings(a.id, { name: ' New name ', summary: 'Better text', priceUsd: '0.2' });
      expect(gw.listings[0]).toMatchObject({ name: 'New name', summary: 'Better text', priceUsd: '0.2' });
      await svc.saveSettings(a.id, { priceUsd: null });
      expect(gw.listings[0]?.priceUsd).toBeNull();
      expect(await code(svc.saveSettings(a.id, {}))).toBe('bad-input');
      expect(await code(svc.saveSettings(a.id, { name: '' }))).toBe('bad-input');
      expect(await code(svc.saveSettings(a.id, { priceUsd: 'lots' }))).toBe('bad-input');
    });
    it('deletes a live agent: off, archived, gone', async () => {
      const a = builtAgent({ status: 'ACTIVE' });
      await svc.remove(a.id);
      expect(mcp.calls.map((c) => c.name).filter((n) => ['unpublish_workflow', 'archive_workflow'].includes(n))).toEqual(['unpublish_workflow', 'archive_workflow']);
      expect(gw.listings).toEqual([]);
    });
    it('deletes a draft, and an agent that never had a workflow, without touching n8n', async () => {
      await svc.remove(gw.seed({ tags: ['zynd-studio'] }).id);
      expect(mcp.calls).toEqual([]);
      await svc.remove(builtAgent().id);
      expect(mcp.callsTo('unpublish_workflow')).toEqual([]);
      expect(mcp.callsTo('archive_workflow')).toHaveLength(1);
      expect(gw.listings).toEqual([]);
    });
    it('still deletes when n8n has already lost the workflow', async () => {
      const a = builtAgent();
      mcp.failTool.archive_workflow = 'not found';
      await svc.remove(a.id);
      expect(gw.listings).toEqual([]);
    });
    it('refuses to delete another person\'s agent', async () => {
      expect(await code(svc.remove('someone-elses'))).toBe('not-found');
    });
  });

  describe('activity (S3.4)', () => {
    it('merges the person\'s tries and uses by other agents, newest first, in plain words', async () => {
      const a = builtAgent();
      mcp.searchResults = { data: [{ id: '9', status: 'success', mode: 'chat', startedAt: '2026-11-16T10:30:00.000Z' }, { id: '8', status: 'success', mode: 'webhook', startedAt: '2026-11-16T10:20:00.000Z' }] };
      mcp.executions.set('9', finishedRun({ request: 'Earlier in this chat:\nUser: hi\n\nNew message from the user:\nCheck ACME Ltd', steps: [{ action: { tool: 'Counterparty_Check' }, observation: JSON.stringify([{ taskId: 't', status: 'COMPLETED', paymentUsd: '0.050000' }]) }] }));
      gw.tasks = [
        { id: 't1', listingId: a.id, direction: 'INBOUND', callerId: 'zns:x', status: 'COMPLETED', paymentUsd: '0.150000', error: null, createdAt: '2026-11-16T10:40:00.000Z', updatedAt: '' },
        { id: 't2', listingId: a.id, direction: 'INBOUND', callerId: 'zns:y', status: 'FAILED', paymentUsd: null, error: 'boom', createdAt: '2026-11-16T09:00:00.000Z', updatedAt: '' },
      ];
      const items = await svc.activity(a.id);
      expect(items.map((i) => [i.kind, i.title, i.ok, i.amountUsd])).toEqual([
        ['other', 'Hired by another agent', true, '0.150000'],
        ['you', 'Check ACME Ltd', true, '0.050000'],
        ['other', 'Hired by another agent', false, '0'],
      ]);
      expect(JSON.stringify(items)).not.toMatch(/boom|zns:x|zns:y/); // no errors or other agents' ids
    });
    it('is empty when there is nothing, and survives n8n being down', async () => {
      const a = builtAgent();
      expect(await svc.activity(a.id)).toEqual([]);
      mcp.failTool.search_workflow_executions = 'down';
      expect(await svc.activity(a.id)).toEqual([]);
    });
  });
});

describe('composeRequest', () => {
  it('is just the message with no history, and trims history to the last four turns', () => {
    expect(composeRequest('Hi')).toBe('Hi');
    const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? ('agent' as const) : ('user' as const), text: `turn ${i}` }));
    const text = composeRequest('Next', history);
    expect(text).not.toContain('turn 1');
    expect(text).toContain('turn 2');
    expect(text).toContain('turn 5');
    expect(lastMessage(text)).toBe('Next');
  });
  it('cuts very long earlier turns', () => {
    expect(composeRequest('x', [{ role: 'user', text: 'a'.repeat(5000) }]).length).toBeLessThan(900);
  });
});

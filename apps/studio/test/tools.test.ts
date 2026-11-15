import { beforeEach, describe, expect, it } from 'vitest';
import type { BuildEvent } from '@/lib/builder/events';
import { TOOL_SPECS, createBuilderTools, type BuilderToolsDeps } from '@/lib/builder/tools';
import { checkWorkflow } from '@/lib/n8n/policy';
import { WorkflowRelay } from '@/lib/n8n/relay';
import type { HelperCard } from '@/lib/registry';
import { FakeMcp, finishedRun } from './helpers/fakeMcp';
import { interpret } from './helpers/interpret';
import { HELPER_ID, LISTING_ID, OPENAI_CRED, ZYND_CRED, ctx, goodWorkflow } from './helpers/readback';

const CHECK: HelperCard = { entityId: HELPER_ID, name: 'Counterparty Check', what: 'Confirms a UK company exists. In: company name, number or LEI.', category: 'compliance', priceUsd: '0.05' };
const WALLET: HelperCard = { entityId: 'zns:7e2b5c1f9628fe2429a9d663bd03111b', name: 'Wallet Risk Screener', what: 'Screens a payment address.', category: 'compliance', priceUsd: '0.03' };

describe('builder tools', () => {
  let mcp: FakeMcp;
  let events: BuildEvent[];
  let saved: { name: string; summary: string; priceUsd: string }[];
  let known: Map<string, HelperCard>;
  let searched: string[];
  let listing: { id: string; name: string };
  let bindState: { workflowId: string | null };
  let deps: BuilderToolsDeps;
  let tools: ReturnType<typeof createBuilderTools>;

  const call = async (name: string, args: unknown = {}) => JSON.parse(await tools.run(name, typeof args === 'string' ? args : JSON.stringify(args))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const progress = () => events.filter((e): e is Extract<BuildEvent, { type: 'progress' }> => e.type === 'progress').map((e) => e.step);

  const build = (over: Partial<BuilderToolsDeps> = {}) => {
    bindState = { workflowId: null };
    const relay = new WorkflowRelay(
      mcp,
      {
        get workflowId() {
          return bindState.workflowId;
        },
        set workflowId(v) {
          bindState.workflowId = v;
        },
        remember: async () => {},
        workflowName: () => 'Supplier Check · 11111111',
      },
      ctx,
    );
    deps = {
      listing,
      save: async (p) => void saved.push(p),
      relay,
      registry: { search: async (q) => (searched.push(q), [...known.values()]), lookup: (id) => known.get(id) },
      dataSources: ctx.dataSources,
      agentModel: 'gpt-5-mini',
      zyndCredentialName: 'Zynd · ada-x7k2',
      openAiCredentialName: 'OpenAI account',
      emit: (e) => void events.push(e),
      pollMs: 0,
      sleep: async () => {},
      testTimeoutMs: 50,
      ...over,
    };
    tools = createBuilderTools(deps);
  };

  beforeEach(() => {
    mcp = new FakeMcp();
    events = [];
    saved = [];
    searched = [];
    known = new Map([CHECK, WALLET].map((c) => [c.entityId, c]));
    listing = { id: LISTING_ID, name: 'New agent' };
    build();
  });

  it('offers exactly the tools the plan allows, nothing that publishes, deletes or runs raw n8n calls', () => {
    const names = TOOL_SPECS.map((s) => s.name);
    expect(names).toEqual(['find_helpers', 'list_data_sources', 'update_preview', 'get_template', 'test_agent', 'progress', 'search_nodes', 'get_node_types', 'get_workflow_sdk_reference', 'get_workflow_best_practices', 'validate_workflow', 'create_workflow_from_code', 'update_workflow', 'get_workflow_details']);
    for (const bad of ['publish_workflow', 'unpublish_workflow', 'archive_workflow', 'execute_workflow', 'list_credentials', 'create_agent']) expect(names).not.toContain(bad);
    // Function tools are strict by default in the Responses API; these have optional arguments.
    expect(TOOL_SPECS.every((s) => s.strict === false)).toBe(true);
    // No tool lets the model name a workflow id.
    expect(JSON.stringify(TOOL_SPECS)).not.toMatch(/"workflowId"/);
  });

  describe('finding things', () => {
    it('find_helpers lists the cards with ids and prices', async () => {
      const out = await call('find_helpers', { query: 'company check' });
      expect(searched).toEqual(['company check']);
      expect(out).toEqual([
        { id: CHECK.entityId, name: 'Counterparty Check', what: CHECK.what, price_usd: '0.05' },
        { id: WALLET.entityId, name: 'Wallet Risk Screener', what: WALLET.what, price_usd: '0.03' },
      ]);
      expect((await call('find_helpers', {})).error).toMatch(/query/);
    });
    it('says so when nothing matches', async () => {
      known.clear();
      expect((await call('find_helpers', { query: 'zzz' })).note).toMatch(/No active agents/);
    });
    it('list_data_sources shows the offered sources with their price limits', async () => {
      expect(await call('list_data_sources')).toEqual([{ name: 'Briefpixel news', what: 'News', max_price_usd: '0.01', fields: null }]);
    });
    it('turns a registry failure into an error the model can read', async () => {
      build({ registry: { search: async () => Promise.reject(new Error('The agent directory could not be reached')), lookup: () => undefined }, log: { warn: () => {} } });
      expect((await call('find_helpers', { query: 'x' })).error).toMatch(/Try once more/);
    });
  });

  describe('update_preview', () => {
    const preview = () => events.find((e): e is Extract<BuildEvent, { type: 'preview' }> => e.type === 'preview')?.preview;
    it('shows the card with prices Studio looked up, adds the cost itself, and saves name, description and price', async () => {
      const out = await call('update_preview', { name: 'Supplier Check', description: 'Checks a new supplier before you pay.', helper_ids: [CHECK.entityId, WALLET.entityId], data_sources: ['Briefpixel news'], suggested_price_usd: '0.15' });
      expect(out).toEqual({ shown: true, cost_per_use_usd: '0.090000' });
      expect(preview()).toMatchObject({ name: 'Supplier Check', does: 'Checks a new supplier before you pay.', costUsd: '0.090000', suggestedPriceUsd: '0.15' });
      expect(preview()?.helpers.map((h) => [h.name, h.priceUsd])).toEqual([['Counterparty Check', '0.05'], ['Wallet Risk Screener', '0.03'], ['Briefpixel news', '0.01']]);
      expect(saved).toEqual([{ name: 'Supplier Check', summary: 'Checks a new supplier before you pay.', priceUsd: '0.15' }]);
      expect(listing.name).toBe('Supplier Check');
    });
    it('never takes a price from the model: an id it did not find is refused', async () => {
      const out = await call('update_preview', { name: 'X', description: 'y', helper_ids: ['zns:made-up'] });
      expect(out.error).toMatch(/not a helper you found/);
      expect(events).toEqual([]);
      expect(saved).toEqual([]);
    });
    it('checks the name, the 200-character limit and the data-source names', async () => {
      expect((await call('update_preview', { name: '', description: 'y' })).error).toMatch(/name/);
      expect((await call('update_preview', { name: 'X', description: 'y'.repeat(201) })).error).toMatch(/200/);
      expect((await call('update_preview', { name: 'X', description: 'y', data_sources: ['Unknown'] })).error).toMatch(/Unknown data source/);
      expect(saved).toEqual([]);
    });
    it('suggests 0.10 when the model gives a bad price', async () => {
      await call('update_preview', { name: 'X', description: 'y', suggested_price_usd: 'cheap' });
      expect(preview()?.suggestedPriceUsd).toBe('0.10');
    });
  });

  describe('get_template', () => {
    const args = { instructions: 'You check suppliers. Reply with a short verdict.', helpers: [{ id: CHECK.entityId, input: 'json', fields: 'companyName, companyNumber' }], data_sources: ['Briefpixel news'], web: true };
    it('returns code with the ids filled in, and the code is something the policy accepts', async () => {
      const out = await tools.run('get_template', JSON.stringify(args));
      expect(out).toContain(LISTING_ID);
      expect(out).toContain(HELPER_ID);
      expect(out).toContain('Zynd · ada-x7k2');
      expect(out).toContain('"0.05"'); // the helper's own price is the cap
      const code = out.slice(out.indexOf('import {'));
      const wf = interpret(code, { 'Zynd · ada-x7k2': ZYND_CRED, 'OpenAI account': OPENAI_CRED });
      expect(checkWorkflow(wf, ctx)).toEqual({ blocked: [], missing: [] });
    });
    it('refuses helpers it does not know, unknown sources and instructions that are empty or too long', async () => {
      expect((await call('get_template', { ...args, helpers: [{ id: 'zns:nope', input: 'text' }] })).error).toMatch(/not a helper you found/);
      expect((await call('get_template', { ...args, data_sources: ['Nope'] })).error).toMatch(/Unknown data source/);
      expect((await call('get_template', { instructions: '' })).error).toMatch(/instructions/);
      expect((await call('get_template', { instructions: 'x'.repeat(1501) })).error).toMatch(/too long/);
    });
    it('uses the agent\'s current name for the workflow', async () => {
      listing.name = 'Renamed Agent';
      expect(await tools.run('get_template', JSON.stringify({ instructions: 'Do it.' }))).toContain('Renamed Agent');
    });
  });

  describe('test_agent and "ready" (S2.6)', () => {
    const finished = (answer = 'Looks fine.') => mcp.executions.set('100', finishedRun({ answer }));
    const create = async () => {
      mcp.created = goodWorkflow();
      return call('create_workflow_from_code', { code: 'x' });
    };

    it('refuses "ready" until a test has answered', async () => {
      expect((await call('progress', { step: 'ready' })).error).toMatch(/Not ready yet/);
      expect(progress()).toEqual([]);
      await call('progress', { step: 'building' });
      expect(progress()).toEqual(['building']);
    });

    it('allows "ready" after a test run answered, and shows the answer, helpers and cost', async () => {
      await create();
      mcp.executions.set('100', finishedRun({ answer: 'Verdict: low risk.', steps: [{ action: { tool: 'Counterparty_Check' }, observation: JSON.stringify([{ taskId: 't', status: 'COMPLETED', paymentUsd: '0.050000' }]) }] }));
      const out = await call('test_agent', { question: 'Check ACME Ltd, wallet 0x1' });
      expect(out).toMatchObject({ ok: true, answer: 'Verdict: low risk.', cost_usd: '0.050000', helpers_used: [{ name: 'Counterparty Check', costUsd: '0.050000', ok: true }] });
      expect(mcp.callsTo('execute_workflow')[0]?.args).toMatchObject({ executionMode: 'manual', inputs: { chatInput: 'Check ACME Ltd, wallet 0x1' } });
      expect((await call('progress', { step: 'ready' })).shown).toBe('ready');
      expect(progress()).toEqual(['testing', 'ready']);
    });

    it('does not accept a run that never reached the Answer step, or answered nothing', async () => {
      await create();
      mcp.executions.set('100', finishedRun({ status: 'error', answer: '', error: 'Agent task failed. Task ID: t' }));
      const out = await call('test_agent', { question: 'x' });
      expect(out).toMatchObject({ error: 'The test did not produce an answer.', kind: 'helper' });
      expect((await call('progress', { step: 'ready' })).error).toMatch(/Not ready yet/);
    });

    it('tells the model to stop fixing when the agent is out of credit', async () => {
      await create();
      mcp.executions.set('100', finishedRun({ status: 'error', answer: '', error: 'Payment failed: insufficient balance' }));
      const out = await call('test_agent', { question: 'x' });
      expect(out).toMatchObject({ kind: 'credit' });
      expect(out.hint).toMatch(/ran out of credit/);
    });

    it('gives up on a test that takes too long', async () => {
      await create();
      const out = await call('test_agent', { question: 'x' }); // execution 100 stays "running"
      expect(out).toMatchObject({ error: 'The test took too long.', kind: 'timeout' });
    });

    it('a change after a good test makes "ready" wait for another test', async () => {
      await create();
      finished();
      await call('test_agent', { question: 'x' });
      mcp.onUpdate = () => {};
      await call('update_workflow', { operations: [{ type: 'setNodeDisabled', nodeName: 'Web page reader', disabled: true }] });
      expect((await call('progress', { step: 'ready' })).error).toMatch(/Not ready yet/);
      mcp.executions.set('101', finishedRun({ answer: 'Fine again.' }));
      await call('test_agent', { question: 'y' });
      expect((await call('progress', { step: 'ready' })).shown).toBe('ready');
    });

    it('limits how many tests one turn can run, since each can spend credit', async () => {
      await create();
      finished();
      build({ maxTests: 2 });
      bindState.workflowId = 'wf-1';
      mcp.workflow = goodWorkflow();
      await call('test_agent', { question: 'a' });
      await call('test_agent', { question: 'b' });
      expect((await call('test_agent', { question: 'c' })).error).toMatch(/Enough test runs/);
      expect(mcp.callsTo('execute_workflow')).toHaveLength(2);
    });

    it('will not test an agent that has no workflow yet', async () => {
      expect((await call('test_agent', { question: 'x' })).error).toMatch(/no workflow yet/);
    });
  });

  describe('the n8n tools', () => {
    it('go through the guarded relay: another workflow\'s id is refused, with the reason', async () => {
      await call('create_workflow_from_code', { code: 'x' });
      const out = await call('update_workflow', { workflowId: 'wf-someone-else', operations: [{ type: 'removeNode', nodeName: 'x' }] });
      expect(out.error).toMatch(/not this agent/);
    });
    it('report what was not allowed, so the model can fix it', async () => {
      mcp.created = goodWorkflow((n) => void n.push({ name: 'Run code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {} }));
      const out = await call('create_workflow_from_code', { code: 'x' });
      expect(out.error).toMatch(/not saved/);
      expect(out.problems.join()).toContain('n8n-nodes-base.code');
    });
    it('pass n8n\'s own error text on, shortened', async () => {
      mcp.failTool.validate_workflow = 'Invalid SDK code: unexpected token at line 3';
      expect((await call('validate_workflow', { code: 'x' })).error).toMatch(/unexpected token/);
    });
    it('answer a model that sends broken arguments or an unknown tool', async () => {
      expect((await call('find_helpers', '{oops')).error).toMatch(/not valid JSON/);
      expect((await call('find_helpers', '[1,2]')).error).toMatch(/JSON object/);
      expect((await call('delete_everything', {})).error).toMatch(/does not exist/);
    });
    it('cut very long answers', async () => {
      mcp.callTool = async () => ({ big: 'x'.repeat(50_000) });
      const out = await tools.run('get_workflow_sdk_reference', '{}');
      expect(out.length).toBeLessThan(15_000);
      expect(out).toContain('more characters');
    });
  });
});

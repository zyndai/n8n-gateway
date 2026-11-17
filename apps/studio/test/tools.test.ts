import { beforeEach, describe, expect, it } from 'vitest';
import type { BuildEvent } from '@/lib/builder/events';
import { TOOL_SPECS, createBuilderTools, type BuilderToolsDeps } from '@/lib/builder/tools';
import { checkWorkflow } from '@/lib/n8n/policy';
import { WorkflowRelay } from '@/lib/n8n/relay';
import type { HelperCard } from '@/lib/registry';
import { FakeMcp, finishedRun } from './helpers/fakeMcp';
import { HELPER_ID, LISTING_ID, ZYND_CRED, ctx, goodWorkflow } from './helpers/readback';

const CHECK: HelperCard = { entityId: HELPER_ID, name: 'Counterparty Check', what: 'Confirms a UK company exists. In: company name, number or LEI.', category: 'compliance', priceUsd: '0.05' };
const WALLET: HelperCard = { entityId: 'zns:7e2b5c1f9628fe2429a9d663bd03111b', name: 'Wallet Risk Screener', what: 'Screens a payment address.', category: 'compliance', priceUsd: '0.03' };
const JSON_ONLY: HelperCard = { entityId: 'zns:aaaabbbbccccdddd', name: 'Ledger Lookup', what: 'Looks up a ledger entry. In: JSON with entryId.', category: 'finance', priceUsd: '0.02', inputModes: ['application/json'] };
/** One intermediate step of the AI: a paid helper call that answered, or one that did not. */
const step = (tool: string, answered = true) => ({ action: { tool }, observation: JSON.stringify([{ taskId: 't', status: answered ? 'COMPLETED' : 'FAILED', paymentUsd: answered ? '0.050000' : '0' }]) });

describe('builder tools', () => {
  let mcp: FakeMcp;
  let events: BuildEvent[];
  let saved: { name: string; summary: string; priceUsd?: string }[];
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
      mcp.writer(),
    );
    deps = {
      listing,
      save: async (p) => void saved.push(p),
      relay,
      registry: { search: async (q) => (searched.push(q), [...known.values()]), lookup: (id) => known.get(id) },
      dataSources: ctx.dataSources,
      zyndCredentialName: 'Zynd · ada-x7k2',
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
    known = new Map([CHECK, WALLET, JSON_ONLY].map((c) => [c.entityId, c]));
    listing = { id: LISTING_ID, name: 'New agent' };
    build();
  });

  it('offers only Studio\'s own tools: nothing that writes workflow code, publishes, deletes or calls n8n directly', () => {
    const names = TOOL_SPECS.map((s) => s.name);
    expect(names).toEqual(['find_helpers', 'list_data_sources', 'update_preview', 'build_agent', 'get_agent_setup', 'edit_agent', 'test_agent', 'progress']);
    for (const bad of ['create_workflow_from_code', 'update_workflow', 'get_template', 'validate_workflow', 'publish_workflow', 'archive_workflow', 'execute_workflow', 'list_credentials']) expect(names).not.toContain(bad);
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
        { id: JSON_ONLY.entityId, name: 'Ledger Lookup', what: JSON_ONLY.what, price_usd: '0.02' },
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

  describe('build_agent (S5.1)', () => {
    const args = { instructions: 'You check suppliers. Reply with a short verdict.', helpers: [{ id: CHECK.entityId, input: 'json', fields: 'companyName, companyNumber' }], data_sources: ['Briefpixel news'], web: true };
    it('writes the whole agent itself, with this person\'s credential and the helper\'s own price, and the read-back passes the check', async () => {
      const out = await call('build_agent', args);
      expect(out).toMatchObject({ saved: true, next: expect.stringMatching(/test_agent/) });
      expect(out.tools.map((t: { name: string }) => t.name)).toEqual(['Counterparty Check', 'Briefpixel news', 'Web page reader']);
      const body = mcp.callsTo('rest:create')[0]?.args as { name: string; nodes: { name: string; credentials?: Record<string, { id: string }>; parameters?: Record<string, unknown> }[] };
      expect(body.name).toBe('Supplier Check · 11111111');
      const helper = body.nodes.find((n) => n.name === 'Counterparty Check');
      expect(helper?.credentials?.zyndApi?.id).toBe(ZYND_CRED);
      expect(helper?.parameters).toMatchObject({ agentId: HELPER_ID, maxPaymentUsd: '0.05', payFromListingId: LISTING_ID, inputType: 'json' });
      expect(checkWorkflow(mcp.workflow!, ctx)).toEqual({ blocked: [], missing: [] });
      expect(bindState.workflowId).toBe('wf-1');
      expect(mcp.callsTo('create_workflow_from_code')).toEqual([]);
      expect(tools.state()).toMatchObject({ changed: true, tested: false });
    });
    it('rebuilds over the same workflow on a second call, keeping n8n\'s ids', async () => {
      await call('build_agent', args);
      const triggerId = mcp.workflow!.nodes.find((n) => n.name === 'Zynd Trigger')?.webhookId;
      await call('build_agent', { instructions: 'Shorter now.' });
      expect(mcp.callsTo('rest:create')).toHaveLength(1);
      expect(mcp.callsTo('rest:replace')).toHaveLength(1);
      expect(mcp.workflow!.nodes.find((n) => n.name === 'Zynd Trigger')?.webhookId).toBe(triggerId);
      expect(mcp.workflow!.nodes.map((n) => n.name)).not.toContain('Counterparty Check');
    });
    it('chooses the input type the helper\'s card allows, and plain text when the model does not say', async () => {
      const out = await call('build_agent', { instructions: 'Do it.', helpers: [{ id: JSON_ONLY.entityId, input: 'text' }, { id: WALLET.entityId }] });
      expect(out.tools.map((t: { input?: string }) => t.input)).toEqual(['json', 'text']);
    });
    it('refuses helpers it does not know, unknown sources, too many tools, and instructions that are empty or too long', async () => {
      expect((await call('build_agent', { ...args, helpers: [{ id: 'zns:nope', input: 'text' }] })).error).toMatch(/not a helper you found/);
      expect((await call('build_agent', { ...args, data_sources: ['Nope'] })).error).toMatch(/Unknown data source/);
      expect((await call('build_agent', { instructions: '' })).error).toMatch(/instructions/);
      expect((await call('build_agent', { instructions: 'x'.repeat(1501) })).error).toMatch(/too long/);
      known.set('a', { ...WALLET, entityId: 'a' }).set('b', { ...WALLET, entityId: 'b' }).set('c', { ...WALLET, entityId: 'c' });
      const many = await call('build_agent', { instructions: 'x', helpers: ['a', 'b', 'c', CHECK.entityId, WALLET.entityId].map((id) => ({ id })), data_sources: ['Briefpixel news'] });
      expect(many.error).toMatch(/at most 5/);
      expect(mcp.callsTo('rest:create')).toEqual([]);
    });
    it('passes a failed save on in plain words and keeps nothing', async () => {
      mcp.failTool['rest:create'] = 'request/body must have required property \'settings\'';
      const out = await call('build_agent', args);
      expect(out.error).toMatch(/could not reach the agent service/);
      expect(bindState.workflowId).toBeNull();
    });
    it('sets the right credentials when n8n changed them, and archives a workflow n8n made unsafe', async () => {
      mcp.onCreate = (wf) => void (wf.nodes.find((n) => n.name === 'Zynd Trigger')!.credentials = { zyndApi: { id: 'showcase', name: 'Zynd account' } });
      expect((await call('build_agent', args)).saved).toBe(true);
      expect(mcp.workflow!.nodes.find((n) => n.name === 'Zynd Trigger')?.credentials?.zyndApi?.id).toBe(ZYND_CRED);
      bindState.workflowId = null;
      mcp.onCreate = (wf) => void wf.nodes.push({ name: 'Run code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {} });
      const out = await call('build_agent', args);
      expect(out.error).toMatch(/not saved/);
      expect(mcp.callsTo('archive_workflow')).toHaveLength(1);
      expect(bindState.workflowId).toBeNull();
    });
  });

  describe('test_agent and "ready" (S2.6)', () => {
    const finished = (answer = 'Looks fine.') => mcp.executions.set('100', finishedRun({ answer }));
    const create = async (helpers: unknown[] = [{ id: CHECK.entityId, input: 'json', fields: 'companyName' }]) => call('build_agent', { instructions: 'You check suppliers.', helpers });

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
      expect(out.hint).toMatch(/needs credit/);
      expect(tools.state()).toMatchObject({ noCredit: true, lastFailure: 'credit' });
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
      await call('build_agent', { instructions: 'You check suppliers, briefly.' });
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

    it('will not test an agent that has no version yet', async () => {
      expect((await call('test_agent', { question: 'x' })).error).toMatch(/no version yet/);
    });

    it('does not spend a test when the wallet cannot pay even the cheapest helper', async () => {
      build({ balance: async () => '0.01' });
      await create();
      const out = await call('test_agent', { question: 'x' });
      expect(out).toMatchObject({ kind: 'credit', balance_usd: '0.01' });
      expect(mcp.callsTo('execute_workflow')).toEqual([]);
      expect(tools.state()).toMatchObject({ noCredit: true, tests: 0 });
    });
    it('tests as usual when the balance is enough or unknown', async () => {
      build({ balance: async () => null });
      await create();
      finished();
      expect((await call('test_agent', { question: 'x' })).ok).toBe(true);
    });
  });

  describe('Studio repairs a helper that did not answer (S5.1)', () => {
    it('switches its input type and tests again, then says what it changed', async () => {
      await call('build_agent', { instructions: 'You check suppliers.', helpers: [{ id: CHECK.entityId, input: 'json', fields: 'companyName' }] });
      mcp.executions.set('100', finishedRun({ status: 'error', answer: '', steps: [step('Counterparty_Check', false)], error: 'Agent task failed' }));
      mcp.executions.set('101', finishedRun({ answer: 'Verdict: fine.', steps: [step('Counterparty_Check')] }));
      const out = await call('test_agent', { question: 'Check ACME Ltd' });
      expect(out).toMatchObject({ ok: true, answer: 'Verdict: fine.' });
      expect(out.studio_changed).toEqual(['Counterparty Check did not answer, so Studio now sends it plain text.']);
      expect(mcp.workflow!.nodes.find((n) => n.name === 'Counterparty Check')?.parameters?.inputType).toBe('text');
      expect(tools.state()).toMatchObject({ tested: true, tests: 2, repairs: 1 });
      expect((await call('progress', { step: 'ready' })).shown).toBe('ready');
    });
    it('leaves the helper out when it still gives no answer, and the agent then works without it', async () => {
      await call('build_agent', { instructions: 'You check suppliers.', helpers: [{ id: CHECK.entityId }] });
      const broken = finishedRun({ status: 'error', answer: '', steps: [step('Counterparty_Check', false)], error: 'Agent task failed' });
      mcp.executions.set('100', broken);
      mcp.executions.set('101', broken);
      mcp.executions.set('102', finishedRun({ answer: 'I could not check the registry, but here is what I know.' }));
      const out = await call('test_agent', { question: 'Check ACME Ltd' });
      expect(out.ok).toBe(true);
      expect(out.studio_changed).toEqual(['Counterparty Check did not answer, so Studio now sends it a JSON object.', 'Counterparty Check did not answer, so Studio left it out for now.']);
      expect(mcp.workflow!.nodes.map((n) => n.name)).not.toContain('Counterparty Check');
      expect(tools.state()).toMatchObject({ tests: 3, repairs: 2, tested: true });
    });
    it('never switches to an input type the card does not allow, and never drops a helper from an agent that answered', async () => {
      await call('build_agent', { instructions: 'Look up entries.', helpers: [{ id: JSON_ONLY.entityId, input: 'json', fields: 'entryId' }] });
      mcp.executions.set('100', finishedRun({ answer: 'The ledger did not answer.', steps: [step('Ledger_Lookup', false)] }));
      const out = await call('test_agent', { question: 'Entry 42' });
      expect(out).toMatchObject({ ok: true, not_answering: ['Ledger Lookup'] });
      expect(mcp.callsTo('rest:replace')).toEqual([]);
      expect(tools.state()).toMatchObject({ tests: 1, repairs: 0 });
    });
    it('stays within the test budget', async () => {
      build({ maxTests: 1 });
      await call('build_agent', { instructions: 'You check suppliers.', helpers: [{ id: CHECK.entityId }] });
      mcp.executions.set('100', finishedRun({ status: 'error', answer: '', steps: [step('Counterparty_Check', false)], error: 'Agent task failed' }));
      const out = await call('test_agent', { question: 'x' });
      expect(out).toMatchObject({ error: 'The test did not produce an answer.', kind: 'helper' });
      expect(mcp.callsTo('execute_workflow')).toHaveLength(1);
    });
    it('does not repair an agent changed with edit_agent, since it has no whole picture of it', async () => {
      bindState.workflowId = 'wf-1';
      mcp.workflow = goodWorkflow();
      await call('edit_agent', { instructions: 'Check suppliers.' });
      mcp.executions.set('100', finishedRun({ status: 'error', answer: '', steps: [step('Counterparty_Check', false)], error: 'Agent task failed' }));
      expect((await call('test_agent', { question: 'x' })).kind).toBe('helper');
      expect(tools.state().repairs).toBe(0);
    });
  });

  describe('changing an agent that already exists (S4.1)', () => {
    beforeEach(() => {
      bindState.workflowId = 'wf-1';
      mcp.workflow = goodWorkflow();
    });
    const toolNames = () => (mcp.workflow?.nodes ?? []).map((n) => n.name);

    it('get_agent_setup shows what it does and its tools, with prices but no ids', async () => {
      const out = await call('get_agent_setup');
      expect(out.instructions).toBe('You check suppliers.');
      expect(out.tools).toEqual([
        { name: 'Counterparty Check', kind: 'helper', what: 'Confirms a UK company exists.', max_price_usd: '0.05' },
        { name: 'Briefpixel news', kind: 'data source', what: '', max_price_usd: '0.01' },
        { name: 'Web page reader', kind: 'web', what: expect.any(String) },
      ]);
      expect(JSON.stringify(out)).not.toMatch(/zns:|cred-|11111111/);
    });

    it('get_agent_setup and edit_agent say so when the agent has no version yet', async () => {
      bindState.workflowId = null;
      expect((await call('get_agent_setup')).error).toMatch(/no version yet/);
      expect((await call('edit_agent', { instructions: 'x' })).error).toMatch(/no version yet/);
    });

    it('edit_agent adds a helper the search found, saves it, and the result is usable', async () => {
      const out = await call('edit_agent', { instructions: 'Check the supplier and screen its wallet.', add_helpers: [{ id: WALLET.entityId, input: 'json', fields: 'address' }] });
      expect(out).toMatchObject({ saved: true, usable: true, problems: [] });
      expect(out.tools.map((t: { name: string }) => t.name)).toEqual(['Counterparty Check', 'Briefpixel news', 'Web page reader', 'Wallet Risk Screener']);
      expect(toolNames()).toContain('Wallet Risk Screener');
      const read = checkWorkflow(mcp.workflow!, ctx);
      expect(read).toEqual({ blocked: [], missing: [] });
      expect(mcp.callsTo('update_workflow')[0]?.args).toMatchObject({ workflowId: 'wf-1', versionName: 'Changed by chat' });
    });

    it('edit_agent removes a tool by name and refuses one that is not there', async () => {
      expect(await call('edit_agent', { remove: ['Briefpixel news'] })).toMatchObject({ saved: true });
      expect(toolNames()).not.toContain('Briefpixel news');
      const out = await call('edit_agent', { remove: ['Nope'] });
      expect(out.error).toMatch(/no tool called "Nope"/);
    });

    it('edit_agent refuses helpers it was not shown, sources that are not offered, and empty or too long instructions', async () => {
      expect((await call('edit_agent', { add_helpers: [{ id: 'zns:made-up', input: 'text' }] })).error).toMatch(/not a helper you found/);
      expect((await call('edit_agent', { add_data_sources: ['Unknown'] })).error).toMatch(/Unknown data source/);
      expect((await call('edit_agent', { instructions: '  ' })).error).toMatch(/empty/);
      expect((await call('edit_agent', { instructions: 'x'.repeat(1501) })).error).toMatch(/too long/);
      expect((await call('edit_agent', {})).error).toMatch(/Nothing to change/);
      expect(mcp.callsTo('update_workflow')).toEqual([]);
    });

    it('a change makes "ready" wait for a new test, and state() tells the runner what happened', async () => {
      mcp.executions.set('100', finishedRun({ answer: 'Fine.' }));
      expect(tools.state()).toMatchObject({ changed: false, tested: false });
      await call('test_agent', { question: 'a' });
      expect(tools.state()).toMatchObject({ changed: false, tested: true });
      await call('edit_agent', { web: false });
      expect(tools.state()).toMatchObject({ changed: true, tested: false });
      expect((await call('progress', { step: 'ready' })).error).toMatch(/Not ready yet/);
      mcp.executions.set('101', finishedRun({ answer: 'Fine again.' }));
      await call('test_agent', { question: 'b' });
      expect(tools.state()).toMatchObject({ changed: true, tested: true, tests: 2 });
    });

    it('update_preview on a built agent keeps its price: only the first build suggests one', async () => {
      await call('update_preview', { name: 'Supplier Check 2', description: 'Checks suppliers.', suggested_price_usd: '0.50' });
      expect(saved).toEqual([{ name: 'Supplier Check 2', summary: 'Checks suppliers.' }]);
    });
  });

  describe('the picture and the activity lines (S5.3)', () => {
    const blueprints = () => events.filter((e): e is Extract<BuildEvent, { type: 'blueprint' }> => e.type === 'blueprint');
    const lines = () => {
      const byId = new Map<string, { label: string; state: string }>();
      for (const e of events) if (e.type === 'activity') byId.set(e.activity.id, e.activity);
      return [...byId.values()];
    };
    it('a search is one line that turns from running into what was found', async () => {
      await call('find_helpers', { query: 'company check' });
      const acts = events.filter((e) => e.type === 'activity');
      expect(acts).toHaveLength(2);
      expect(lines()).toEqual([{ id: 'a1', label: 'Found 3 possible helpers', state: 'done' }]);
    });
    it('the agent is planned, built, then ready, with its tools by name and price', async () => {
      await call('update_preview', { name: 'Supplier Check', description: 'Checks suppliers.', helper_ids: [CHECK.entityId] });
      await call('build_agent', { instructions: 'You check suppliers.', helpers: [{ id: CHECK.entityId }] });
      expect(blueprints().map((b) => b.parts.find((p) => p.kind === 'helper')?.state)).toEqual(['planned', 'building', 'ready']);
      const last = blueprints().at(-1)!.parts;
      expect(last.map((p) => p.kind)).toEqual(['network', 'chat', 'request', 'brain', 'helper', 'answer']);
      expect(last.find((p) => p.kind === 'helper')).toMatchObject({ label: 'Counterparty Check', priceUsd: '0.05' });
      expect(lines().map((l) => l.label)).toEqual(['Planned "Supplier Check"', 'Your agent is put together and saved']);
    });
    it('a test lights up the helpers it used, with what each cost, and says how long it took', async () => {
      // The ledger takes JSON only, so Studio has nothing to switch: the picture shows the test as it was.
      await call('build_agent', { instructions: 'You check suppliers.', helpers: [{ id: CHECK.entityId }, { id: JSON_ONLY.entityId, input: 'json' }] });
      mcp.executions.set('100', finishedRun({ answer: 'Fine.', steps: [step('Counterparty_Check'), step('Ledger_Lookup', false)] }));
      await call('test_agent', { question: 'Check ACME Ltd' });
      const parts = blueprints().at(-1)!.parts;
      expect(parts.find((p) => p.label === 'Counterparty Check')).toMatchObject({ state: 'used', costUsd: '0.050000' });
      expect(parts.find((p) => p.label === 'Ledger Lookup')?.state).toBe('failed');
      expect(parts.find((p) => p.kind === 'answer')?.state).toBe('used');
      const trying = blueprints().find((b) => b.parts.some((p) => p.state === 'testing'))!.parts;
      expect(trying.filter((p) => p.state !== 'testing').map((p) => p.kind)).toEqual(['network']);
      expect(lines().map((l) => l.label)).toEqual(expect.arrayContaining(['Counterparty Check answered · $0.05', 'Ledger Lookup did not answer', expect.stringMatching(/^Tried "Check ACME Ltd": it answered in \d+ s$/)]));
    });
    it('a repair shows as its own line, and the picture follows the change', async () => {
      await call('build_agent', { instructions: 'You check suppliers.', helpers: [{ id: CHECK.entityId, input: 'json', fields: 'companyName' }] });
      mcp.executions.set('100', finishedRun({ status: 'error', answer: '', steps: [step('Counterparty_Check', false)], error: 'Agent task failed' }));
      mcp.executions.set('101', finishedRun({ answer: 'Fine.', steps: [step('Counterparty_Check')] }));
      await call('test_agent', { question: 'x' });
      expect(lines().map((l) => l.label)).toContain('Counterparty Check did not answer, so it now gets plain text');
      expect(lines().every((l) => l.state !== 'running')).toBe(true);
    });
    it('a failed save is a failed line, never one left spinning', async () => {
      mcp.failTool['rest:create'] = 'down';
      await call('build_agent', { instructions: 'x' });
      expect(lines()).toEqual([{ id: 'a1', label: 'Could not put your agent together', state: 'failed' }]);
    });
  });

  describe('anything else', () => {
    it('refuses the raw n8n tools the model used to have', async () => {
      for (const name of ['create_workflow_from_code', 'update_workflow', 'get_template', 'get_workflow_details']) expect((await call(name, { code: 'x' })).error).toMatch(/does not exist/);
      expect(mcp.calls).toEqual([]);
    });
    it('answers a model that sends broken arguments or an unknown tool', async () => {
      expect((await call('find_helpers', '{oops')).error).toMatch(/not valid JSON/);
      expect((await call('find_helpers', '[1,2]')).error).toMatch(/JSON object/);
      expect((await call('delete_everything', {})).error).toMatch(/does not exist/);
    });
    it('cuts very long answers', async () => {
      build({ dataSources: Array.from({ length: 80 }, (_, i) => ({ ...ctx.dataSources[0]!, name: `Source ${i}`, what: 'x'.repeat(300) })) });
      const out = await tools.run('list_data_sources', '{}');
      expect(out.length).toBeLessThan(15_000);
      expect(out).toContain('more characters');
    });
  });
});

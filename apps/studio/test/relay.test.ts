import { beforeEach, describe, expect, it } from 'vitest';
import { NODE } from '@/lib/builder/template';
import { RelayRefusal, WorkflowRelay, type WorkflowBinding } from '@/lib/n8n/relay';
import { FakeMcp, finishedRun } from './helpers/fakeMcp';
import { ZYND_CRED, ctx, goodWorkflow, nodeNamed } from './helpers/readback';

describe('WorkflowRelay', () => {
  let mcp: FakeMcp;
  let bind: WorkflowBinding & { saved: string[] };
  let relay: WorkflowRelay;

  const make = (workflowId: string | null = null) => {
    bind = { workflowId, saved: [], remember: async (id) => void bind.saved.push(id), workflowName: () => 'Supplier Check · 11111111' };
    relay = new WorkflowRelay(mcp, bind, ctx);
  };
  const withWorkflow = () => {
    mcp.workflow = goodWorkflow();
    make('wf-1');
  };
  beforeEach(() => {
    mcp = new FakeMcp();
    make();
  });

  describe('what the model may call', () => {
    it('refuses tools that are not on the allow-list, including the ones Studio keeps for itself', async () => {
      for (const tool of ['publish_workflow', 'unpublish_workflow', 'archive_workflow', 'execute_workflow', 'get_workflow_execution', 'list_credentials', 'create_agent', 'add_data_table_rows', 'call_agent', 'search_workflows', 'restore_workflow_version', 'test_workflow']) {
        await expect(relay.callForModel(tool, {})).rejects.toThrow(RelayRefusal);
      }
      expect(mcp.calls).toEqual([]);
    });
    it('passes read-only tools through with only their own arguments', async () => {
      await relay.callForModel('search_nodes', { queries: ['set'], usage: 'workflow', projectId: 'other-project', folderId: 'x' });
      await relay.callForModel('validate_workflow', { code: 'x', extra: 1 });
      expect(mcp.calls).toEqual([
        { name: 'search_nodes', args: { queries: ['set'], usage: 'workflow' } },
        { name: 'validate_workflow', args: { code: 'x' } },
      ]);
    });
  });

  describe('workflow ownership', () => {
    it('refuses a call that names another workflow', async () => {
      withWorkflow();
      await expect(relay.callForModel('update_workflow', { workflowId: 'someone-elses', operations: [{ type: 'removeNode', nodeName: 'x' }] })).rejects.toThrow(/not this agent/);
      await expect(relay.callForModel('get_workflow_details', { workflowId: 'someone-elses' })).rejects.toThrow(/not this agent/);
      expect(mcp.callsTo('update_workflow')).toEqual([]);
    });
    it('refuses a named workflow while the agent has none yet', async () => {
      await expect(relay.callForModel('update_workflow', { workflowId: 'wf-9', operations: [{ type: 'addTags', names: ['x'] }] })).rejects.toThrow(/not this agent/);
    });
    it('always edits the agent\'s own workflow, whatever the model sends', async () => {
      withWorkflow();
      await relay.callForModel('update_workflow', { operations: [{ type: 'setNodeDisabled', nodeName: 'Web page reader', disabled: true }], projectId: 'p', versionName: 'v' });
      expect(mcp.callsTo('update_workflow')[0]?.args).toEqual({ workflowId: 'wf-1', operations: [{ type: 'setNodeDisabled', nodeName: 'Web page reader', disabled: true }], versionName: 'v' });
    });
    it('refuses to change a workflow the agent does not have, and an empty change', async () => {
      await expect(relay.callForModel('update_workflow', { operations: [{ type: 'addTags', names: ['x'] }] })).rejects.toThrow(/no workflow yet/);
      withWorkflow();
      await expect(relay.callForModel('update_workflow', { operations: [] })).rejects.toThrow(/operations/);
    });
  });

  describe('creating', () => {
    it('creates once under Studio\'s name, remembers the id, and tags it', async () => {
      const out = (await relay.callForModel('create_workflow_from_code', { code: 'export default workflow()', name: 'My own name', projectId: 'p1', description: 'd' })) as { saved: boolean; problems: string[] };
      expect(out).toMatchObject({ saved: true, problems: [] });
      const call = mcp.callsTo('create_workflow_from_code')[0]?.args;
      expect(call).toEqual({ code: 'export default workflow()', description: 'd', name: 'Supplier Check · 11111111' });
      expect(bind.saved).toEqual(['wf-1']);
      expect(relay.workflowId).toBe('wf-1');
      expect(mcp.callsTo('update_workflow')[0]?.args).toEqual({ workflowId: 'wf-1', operations: [{ type: 'addTags', names: ['zynd-studio'] }] });
    });
    it('refuses a second workflow', async () => {
      withWorkflow();
      await expect(relay.callForModel('create_workflow_from_code', { code: 'x' })).rejects.toThrow(/already has a workflow/);
      expect(mcp.callsTo('create_workflow_from_code')).toEqual([]);
    });
    it('archives and does not keep a workflow that contains something not allowed', async () => {
      mcp.created = goodWorkflow((n) => void n.push({ name: 'Run code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {} }));
      const err = await relay.callForModel('create_workflow_from_code', { code: 'x' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RelayRefusal);
      expect((err as RelayRefusal).problems.join()).toContain('n8n-nodes-base.code');
      expect(mcp.callsTo('archive_workflow')[0]?.args).toEqual({ workflowId: 'wf-1' });
      expect(bind.saved).toEqual([]);
      expect(relay.workflowId).toBeNull();
    });
    it('replaces the credential n8n picked by type with this person\'s own, then keeps the workflow', async () => {
      // n8n attaches the first credential of the right type, whatever name the code asked for.
      mcp.created = goodWorkflow((n) => {
        for (const x of n) if (x.credentials?.zyndApi) x.credentials = { zyndApi: { id: 'showcase-cred', name: 'Zynd account' } };
        delete nodeNamed(n, NODE.model).credentials;
      });
      const out = (await relay.callForModel('create_workflow_from_code', { code: 'x' })) as { saved: boolean; problems: string[] };
      expect(out).toMatchObject({ saved: true, problems: [] });
      const ops = mcp.callsTo('update_workflow')[0]?.args.operations as Record<string, unknown>[];
      expect(ops.every((o) => o.type === 'setNodeCredential')).toBe(true);
      expect(ops.find((o) => o.nodeName === NODE.zynd)).toEqual({ type: 'setNodeCredential', nodeName: NODE.zynd, credentialKey: 'zyndApi', credentialId: ZYND_CRED, credentialName: 'Zynd · ada-x7k2' });
      expect(ops.find((o) => o.nodeName === NODE.model)).toMatchObject({ credentialKey: 'openAiApi', credentialId: ctx.openAiCredentialId });
      expect(mcp.workflow?.nodes.filter((x) => x.credentials?.zyndApi).every((x) => x.credentials?.zyndApi?.id === ZYND_CRED)).toBe(true);
      expect(bind.saved).toEqual(['wf-1']);
    });
    it('still refuses a credential of a type the step does not need, and a trigger bound to another listing', async () => {
      mcp.created = goodWorkflow((n) => void (nodeNamed(n, NODE.request).credentials = { httpHeaderAuth: { id: 'secret', name: 'Some key' } }));
      await expect(relay.callForModel('create_workflow_from_code', { code: 'x' })).rejects.toThrow(RelayRefusal);
      expect(mcp.callsTo('archive_workflow')).toHaveLength(1);
      mcp.created = goodWorkflow((n) => void (nodeNamed(n, NODE.zynd).parameters = { listingId: 'another', responseMode: 'lastNode' }));
      make();
      await expect(relay.callForModel('create_workflow_from_code', { code: 'x' })).rejects.toThrow(RelayRefusal);
      expect(bind.saved).toEqual([]);
    });
    it('archives what it created when the read-back fails', async () => {
      mcp.failTool.get_workflow_details = 'n8n is restarting';
      await expect(relay.callForModel('create_workflow_from_code', { code: 'x' })).rejects.toThrow(/restarting/);
      expect(mcp.callsTo('archive_workflow')[0]?.args).toEqual({ workflowId: 'wf-1' });
      expect(bind.saved).toEqual([]);
    });
    it('keeps a safe but unfinished workflow and says what is missing', async () => {
      mcp.created = goodWorkflow((n) => n.filter((x) => x.name !== NODE.answer));
      const out = (await relay.callForModel('create_workflow_from_code', { code: 'x' })) as { saved: boolean; problems: string[] };
      expect(out.saved).toBe(true);
      expect(out.problems.join()).toContain('Answer');
    });
    it('reports a failed creation without saving anything', async () => {
      mcp.failTool.create_workflow_from_code = 'Invalid SDK code: unexpected token';
      await expect(relay.callForModel('create_workflow_from_code', { code: 'x' })).rejects.toThrow(/unexpected token/);
      expect(bind.saved).toEqual([]);
    });
  });

  describe('saveAgent (S5.1)', () => {
    const spec = { instructions: 'Check suppliers.', helpers: [], sources: [], web: false };
    it('refuses when Studio has no way to write workflows', async () => {
      await expect(relay.saveAgent(spec)).rejects.toThrow(/cannot save agents/);
    });
    it('checks the agent before writing anything, so an unsafe one never reaches n8n', async () => {
      relay = new WorkflowRelay(mcp, bind, ctx, mcp.writer());
      const offShelf = { name: 'Secret DB', listingUrl: 'https://internal.example/', operation: 'dump', what: 'x', maxPriceUsd: '0.01' };
      const err = await relay.saveAgent({ ...spec, sources: [offShelf] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RelayRefusal);
      expect((err as RelayRefusal).problems.join()).toMatch(/offered data sources/);
      expect(mcp.calls).toEqual([]);
    });
    it('creates, remembers and tags a new agent', async () => {
      relay = new WorkflowRelay(mcp, bind, ctx, mcp.writer());
      expect(await relay.saveAgent(spec)).toMatchObject({ created: true, problems: [] });
      expect(bind.saved).toEqual(['wf-1']);
      expect(mcp.callsTo('update_workflow').at(-1)?.args.operations).toEqual([{ type: 'addTags', names: ['zynd-studio'] }]);
    });
  });

  describe('updating', () => {
    it('reads the workflow back and reports a problem it introduced, without throwing', async () => {
      withWorkflow();
      mcp.onUpdate = (wf) => void wf.nodes.push({ name: 'Run code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {} });
      const out = (await relay.callForModel('update_workflow', { operations: [{ type: 'addNode', node: { name: 'Run code', type: 'n8n-nodes-base.code', typeVersion: 2 } }] })) as { usable: boolean; problems: string[] };
      expect(out.usable).toBe(false);
      expect(out.problems.join()).toContain('n8n-nodes-base.code');
    });
    it('reports a clean edit as usable', async () => {
      withWorkflow();
      const out = (await relay.callForModel('update_workflow', { operations: [{ type: 'setNodeDisabled', nodeName: 'x', disabled: true }] })) as { usable: boolean; problems: string[] };
      expect(out).toMatchObject({ usable: true, problems: [] });
    });
  });

  describe('what it reads back for the model', () => {
    it('gives steps and connections, never credential ids', async () => {
      withWorkflow();
      const out = JSON.stringify(await relay.callForModel('get_workflow_details', {}));
      expect(out).toContain('Counterparty Check');
      expect(out).not.toContain('cred-zynd-ada');
      expect(out).not.toContain('credentials');
    });
  });

  describe('running', () => {
    it('starts a manual or production chat run on the agent\'s own workflow, after re-checking it', async () => {
      withWorkflow();
      expect(await relay.startRun('Check ACME', 'manual')).toBe('100');
      expect(await relay.startRun('Check ACME', 'production')).toBe('101');
      expect(mcp.callsTo('execute_workflow').map((c) => c.args)).toEqual([
        { workflowId: 'wf-1', executionMode: 'manual', triggerNodeName: NODE.chat, inputs: { chatInput: 'Check ACME' } },
        { workflowId: 'wf-1', executionMode: 'production', triggerNodeName: NODE.chat, inputs: { chatInput: 'Check ACME' } },
      ]);
    });
    it('does not run a workflow that was changed to contain something not allowed (checked again right before running)', async () => {
      withWorkflow();
      nodeNamed(mcp.workflow?.nodes ?? [], 'Web page reader').parameters = { method: 'GET', url: 'http://localhost:5678/rest/credentials' };
      const err = await relay.startRun('x', 'manual').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RelayRefusal);
      expect((err as RelayRefusal).problems.join()).toContain('internal address');
      expect(mcp.callsTo('execute_workflow')).toEqual([]);
    });
    it('does not run an unfinished workflow', async () => {
      withWorkflow();
      mcp.workflow = goodWorkflow((n) => n.filter((x) => x.name !== NODE.answer));
      await expect(relay.startRun('x', 'manual')).rejects.toThrow(/not finished/);
    });
    it('turns n8n\'s "no published version" answer into a refusal', async () => {
      withWorkflow();
      mcp.executeReply = () => ({ executionId: null, status: 'error', error: "Workflow 'wf-1' has no published (active) version to execute" });
      await expect(relay.startRun('x', 'production')).rejects.toThrow(/no published/);
    });
    it('reads a run, with the paid helpers, and refuses a run of another workflow', async () => {
      withWorkflow();
      mcp.executions.set('7', finishedRun({ steps: [{ action: { tool: 'Counterparty_Check' }, observation: JSON.stringify([{ taskId: 't', status: 'COMPLETED', paymentUsd: '0.050000' }]) }] }));
      const v = await relay.readRun('7');
      expect(v).toMatchObject({ status: 'success', answer: 'All good.', costUsd: '0.050000', request: 'Check ACME' });
      expect(mcp.callsTo('get_workflow_execution')[0]?.args).toEqual({ workflowId: 'wf-1', executionId: '7', includeData: true, nodeNames: [NODE.request, NODE.ai, NODE.answer] });
      expect(JSON.stringify(v)).not.toContain('never-forwarded');
      mcp.executions.set('8', finishedRun({ workflowId: 'wf-other' }));
      await expect(relay.readRun('8')).rejects.toThrow(/another agent/);
    });
    it('lists only in-app runs', async () => {
      withWorkflow();
      mcp.searchResults = { data: [{ id: '5', status: 'success', mode: 'webhook', startedAt: 'a' }, { id: '4', status: 'success', mode: 'chat', startedAt: 'b' }, { id: '3', status: 'error', mode: 'manual', startedAt: 'c' }] };
      expect(await relay.listRuns()).toEqual([{ id: '4', status: 'success', startedAt: 'b' }, { id: '3', status: 'error', startedAt: 'c' }]);
    });
  });

  describe('publishing, which only Studio does', () => {
    it('checks the workflow, then publishes it', async () => {
      withWorkflow();
      await relay.publish();
      expect(mcp.callsTo('publish_workflow')[0]?.args).toEqual({ workflowId: 'wf-1' });
    });
    it('will not publish a workflow with something not allowed', async () => {
      withWorkflow();
      mcp.workflow = goodWorkflow((n) => void n.push({ name: 'Run code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {} }));
      await expect(relay.publish()).rejects.toThrow(RelayRefusal);
      expect(mcp.callsTo('publish_workflow')).toEqual([]);
    });
    it('unpublishes and archives its own workflow only', async () => {
      withWorkflow();
      await relay.unpublish();
      await relay.archive();
      expect(mcp.calls.map((c) => [c.name, c.args.workflowId])).toEqual([['unpublish_workflow', 'wf-1'], ['archive_workflow', 'wf-1']]);
    });
  });

  describe('is a change live yet? (S4.1)', () => {
    const state = (over: Record<string, unknown>) => {
      withWorkflow();
      Object.assign(mcp.workflow as object, over);
    };
    it('yes while a live agent has a newer saved version than the one running', async () => {
      state({ active: true, versionId: 'v2', activeVersionId: 'v1' });
      expect(await relay.draftAhead()).toBe(true);
    });
    it('no when the running version is the newest, or the agent is not turned on', async () => {
      state({ active: true, versionId: 'v2', activeVersionId: 'v2' });
      expect(await relay.draftAhead()).toBe(false);
      state({ active: false, versionId: 'v2', activeVersionId: null });
      expect(await relay.draftAhead()).toBe(false);
    });
    it('unknown when n8n does not say', async () => {
      state({ active: true });
      expect(await relay.draftAhead()).toBeUndefined();
    });
  });

  describe('changing the agent as a whole (S4.1)', () => {
    it('applies Studio\'s own operations atomically, with this agent\'s ids, and reports problems', async () => {
      withWorkflow();
      const { result, tools } = await relay.applyEdit({ web: false, instructions: 'Check suppliers.' }, 'Zynd · ada-x7k2');
      expect(result).toEqual({ saved: true, usable: true, problems: [] });
      expect(tools.map((t) => t.name)).toEqual(['Counterparty Check', 'Briefpixel news']);
      const call = mcp.callsTo('update_workflow').at(-1)?.args as { workflowId: string; operations: { type: string }[] };
      expect(call.workflowId).toBe('wf-1');
      expect(call.operations.map((o) => o.type)).toEqual(['removeNode', 'setNodeParameter']);
    });
    it('refuses, with the reason, an edit the planner cannot make; nothing is sent to n8n', async () => {
      withWorkflow();
      await expect(relay.applyEdit({ remove: ['Nope'] }, 'Zynd · ada-x7k2')).rejects.toThrow(/no tool called "Nope"/);
      expect(mcp.callsTo('update_workflow')).toEqual([]);
    });
    it('needs an agent that has a workflow', async () => {
      await expect(relay.applyEdit({ web: false }, 'Zynd · ada-x7k2')).rejects.toThrow(/no workflow yet/);
    });
    it('reads the setup without ids', async () => {
      withWorkflow();
      const setup = await relay.setup();
      expect(setup.instructions).toBe('You check suppliers.');
      expect(setup.tools).toHaveLength(3);
    });
  });
});

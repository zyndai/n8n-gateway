// S6.1: agents find other agents while they answer and hire one. What may be in the workflow, how an edit adds it and
// how it is told to the AI.
import { describe, expect, it } from 'vitest';
import { currentInstructions, findNode, hireNode, planEdit, toolsOf, type AgentEdit, type EditEnv } from '@/lib/builder/edit';
import { FIND_TOOL_NAME, HIRE_TOOL_NAME, RUNTIME_HIRE_MAX_USD, hasNetworkSteps, isFindStep, isHireStep, isRuntimeAgentExpr, networkRules } from '@/lib/builder/network';
import { NODE, instructionsOf } from '@/lib/builder/template';
import { renderWorkflowJson, type AgentSpec } from '@/lib/builder/workflow-json';
import { checkWorkflow, type N8nNode, type N8nWorkflow } from '@/lib/n8n/policy';
import { applyOps } from './helpers/applyOps';
import { LISTING_ID, OPENAI_CRED, ZYND_CRED, ctx, goodWorkflow, nodeNamed } from './helpers/readback';

const toolEnv = { listingId: LISTING_ID, zyndCredential: { id: ZYND_CRED, name: 'Zynd · ada-x7k2' } };
const env: EditEnv = { ...toolEnv, maxCallPriceUsd: '0.25' };
const spec: AgentSpec = { instructions: 'You research companies.', helpers: [], sources: [], web: false };
const render = (s: AgentSpec = spec) => renderWorkflowJson(s, { ...toolEnv, name: 'A · 11111111', model: ctx.agentModel, openAiCredential: { id: OPENAI_CRED, name: 'OpenAI account' } });

/** A finished agent that also has the two steps. */
const withNetwork = (change?: (n: N8nNode[]) => void) =>
  goodWorkflow((nodes) => {
    nodes.push(findNode(FIND_TOOL_NAME, toolEnv, [0, 0]), hireNode(HIRE_TOOL_NAME, toolEnv, [0, 0]));
    change?.(nodes);
  });
const verdict = (wf: N8nWorkflow) => checkWorkflow(wf, ctx);
const blocked = (change: (n: N8nNode[]) => void) => verdict(withNetwork(change)).blocked.join(' | ');

describe('the find and hire steps', () => {
  it('pass the policy as Studio writes them', () => {
    expect(verdict(withNetwork())).toEqual({ blocked: [], missing: [] });
  });
  it('are recognised by what they do, not by their name', () => {
    const wf = withNetwork();
    expect(wf.nodes.filter(isFindStep).map((n) => n.name)).toEqual([FIND_TOOL_NAME]);
    expect(wf.nodes.filter(isHireStep).map((n) => n.name)).toEqual([HIRE_TOOL_NAME]);
    expect(hasNetworkSteps(wf.nodes)).toBe(true);
    expect(hasNetworkSteps(goodWorkflow().nodes)).toBe(false);
    // a helper hired by a fixed id is not the hire step
    expect(goodWorkflow().nodes.some(isHireStep)).toBe(false);
  });
  it('are not listed among the tools a person picked', () => {
    expect(toolsOf(withNetwork()).map((t) => t.name)).toEqual(['Counterparty Check', 'Briefpixel news', 'Web page reader']);
  });
  it('pay from this agent\'s wallet with a fixed ceiling, the id and the request are the AI\'s', () => {
    const hire = hireNode(HIRE_TOOL_NAME, toolEnv, [0, 0]);
    expect(hire.parameters).toMatchObject({ operation: 'callAgent', payFrom: 'listing', payFromListingId: LISTING_ID, maxPaymentUsd: RUNTIME_HIRE_MAX_USD, inputType: 'text' });
    expect(isRuntimeAgentExpr(hire.parameters?.agentId)).toBe(true);
    expect(String(hire.parameters?.inputText)).toContain("$fromAI('request'");
  });
});

describe('the policy on the hire step: the AI may choose the agent, nothing else', () => {
  it.each([
    ['an expression that is not the AI\'s id', (h: N8nNode) => (h.parameters!.agentId = '={{ $json.chatInput }}')],
    ['a $fromAI with extra code behind it', (h: N8nNode) => (h.parameters!.agentId = "={{ /*n8n-auto-generated-fromAI-override*/ $fromAI('agentId', 'x') + $env.SECRET }}")],
    ['a $fromAI under another key', (h: N8nNode) => (h.parameters!.agentId = "={{ /*n8n-auto-generated-fromAI-override*/ $fromAI('other', 'x') }}")],
  ])('refuses %s', (_name, change) => {
    const why = blocked((n) => change(n.find(isHireStep) ?? nodeNamed(n, HIRE_TOOL_NAME)));
    expect(why).toContain('must hire one fixed helper');
  });
  it('refuses a ceiling above the most one hire may cost', () => {
    expect(blocked((n) => (nodeNamed(n, HIRE_TOOL_NAME).parameters!.maxPaymentUsd = '0.26'))).toContain('may cost at most $0.25');
  });
  it('refuses a ceiling that is an expression', () => {
    expect(blocked((n) => (nodeNamed(n, HIRE_TOOL_NAME).parameters!.maxPaymentUsd = '={{ $json.cap }}'))).toContain('fixed maxPaymentUsd');
  });
  it('refuses paying from anywhere but this agent\'s own wallet', () => {
    expect(blocked((n) => (nodeNamed(n, HIRE_TOOL_NAME).parameters!.payFrom = 'developer'))).toContain('own wallet');
    expect(blocked((n) => (nodeNamed(n, HIRE_TOOL_NAME).parameters!.payFromListingId = 'someone-elses-listing'))).toContain('own wallet');
  });
  it('refuses a second step that hires whoever the AI picks', () => {
    expect(blocked((n) => n.push({ ...hireNode('Hire again', toolEnv, [0, 0]) }))).toContain('Only one step that hires');
  });
  it('refuses a hire step that sends JSON', () => {
    expect(blocked((n) => (nodeNamed(n, HIRE_TOOL_NAME).parameters!.inputType = 'json'))).toContain('plain text');
  });
  it('still wants a fixed id on every other hire: the AI\'s choice is only the one hire step\'s', () => {
    const asAi = "={{ /*n8n-auto-generated-fromAI-override*/ $fromAI('agentId', 'x') }}";
    expect(blocked((n) => (nodeNamed(n, 'Counterparty Check').parameters!.agentId = asAi))).toContain('Only one step that hires');
    expect(blocked((n) => (nodeNamed(n, 'Counterparty Check').parameters!.agentId = '={{ $json.id }}'))).toContain('must hire one fixed helper');
  });
});

describe('the policy on the find step', () => {
  it('wants a fixed, small number of results', () => {
    expect(blocked((n) => delete nodeNamed(n, FIND_TOOL_NAME).parameters!.limit)).toContain('fixed number of results');
    expect(blocked((n) => (nodeNamed(n, FIND_TOOL_NAME).parameters!.limit = 500))).toContain('fixed number of results');
    expect(blocked((n) => (nodeNamed(n, FIND_TOOL_NAME).parameters!.limit = '={{ 500 }}'))).toContain('fixed number of results');
  });
  it('refuses a second search step and any other operation', () => {
    expect(blocked((n) => n.push(findNode('Search again', toolEnv, [0, 0])))).toContain('Only one step that searches');
    expect(blocked((n) => (nodeNamed(n, FIND_TOOL_NAME).parameters!.operation = 'completeJob'))).toContain('may only use operation');
    expect(blocked((n) => (nodeNamed(n, FIND_TOOL_NAME).parameters!.operation = 'listListings'))).toContain('may only use operation');
  });
  it('needs the person\'s Zynd credential like any other Zynd step', () => {
    const wf = withNetwork((n) => delete nodeNamed(n, FIND_TOOL_NAME).credentials);
    expect(verdict(wf).missing.join(' ')).toContain('no zyndApi credential');
  });
});

describe('a new agent', () => {
  it('has both steps, plugged into the AI step, and passes the policy', () => {
    const { workflow } = render();
    expect(verdict(workflow)).toEqual({ blocked: [], missing: [] });
    expect(hasNetworkSteps(workflow.nodes)).toBe(true);
    for (const name of [FIND_TOOL_NAME, HIRE_TOOL_NAME]) expect(workflow.connections[name]?.ai_tool?.[0]?.[0]).toEqual({ node: NODE.ai, type: 'ai_tool', index: 0 });
  });
  it('keeps the progress setting on, so the app can follow a run as it happens', () => {
    expect(render().workflow.settings.saveExecutionProgress).toBe(true);
  });
  it('is told when to search, who it must not hire and how much a hire may cost, and the person\'s own words stay readable', () => {
    const own = 'zns:0123456789abcdef0123456789abcdef';
    const { systemMessage, workflow } = renderWorkflowJson(spec, { ...toolEnv, name: 'A', model: ctx.agentModel, openAiCredential: { id: OPENAI_CRED, name: 'x' }, ownEntityId: own });
    expect(systemMessage).toContain(`"${FIND_TOOL_NAME}"`);
    expect(systemMessage).toContain(`never hire yourself`);
    expect(systemMessage).toContain(own);
    expect(systemMessage).toContain(`$${RUNTIME_HIRE_MAX_USD}`);
    expect(instructionsOf(systemMessage)).toBe('You research companies.');
    expect(currentInstructions(workflow)).toBe('You research companies.');
  });
  it('can be built without them', () => {
    const { workflow, systemMessage } = render({ ...spec, network: false });
    expect(hasNetworkSteps(workflow.nodes)).toBe(false);
    expect(systemMessage).not.toContain('Finding other agents');
  });
  it('says "never hire yourself" even before it has an id', () => {
    expect(networkRules()).toContain('Never hire yourself');
    expect(networkRules('not-an-id')).not.toContain('not-an-id');
  });
});

describe('an edit brings an older agent up to date', () => {
  const run = (edit: AgentEdit, wf: N8nWorkflow = goodWorkflow()) => {
    const plan = planEdit(wf, edit, env);
    if (!plan.ok) throw new Error(plan.error);
    const after = structuredClone(wf);
    applyOps(after, plan.operations);
    return { plan, after, message: String((nodeNamed(after.nodes, NODE.ai).parameters?.options as { systemMessage: string }).systemMessage) };
  };

  it('adds both steps to an agent that lacks them, and tells the AI how to use them', () => {
    const { after, message } = run({ instructions: 'Check suppliers.' });
    expect(hasNetworkSteps(after.nodes)).toBe(true);
    expect(verdict(after)).toEqual({ blocked: [], missing: [] });
    expect(message).toContain('Finding other agents:');
  });
  it('adds them only once', () => {
    const first = run({ instructions: 'One.' });
    const second = run({ instructions: 'Two.' }, first.after);
    expect(second.after.nodes.filter(isFindStep)).toHaveLength(1);
    expect(second.after.nodes.filter(isHireStep)).toHaveLength(1);
    expect(second.message.match(/Finding other agents:/g)).toHaveLength(1);
  });
  it('takes them away when asked, and the AI stops being told about them', () => {
    const { after, message } = run({ network: false }, withNetwork());
    expect(hasNetworkSteps(after.nodes)).toBe(false);
    expect(after.nodes.some(isFindStep) || after.nodes.some(isHireStep)).toBe(false);
    expect(message).not.toContain('Finding other agents');
    expect(verdict(after)).toEqual({ blocked: [], missing: [] });
  });
  it('does not touch an agent that already has them when only a helper is added', () => {
    const wf = withNetwork();
    const plan = planEdit(wf, { web: false }, env);
    expect(plan.ok && plan.operations.filter((o) => o.type === 'addNode')).toEqual([]);
  });
  it('the AI cannot remove them as if they were a tool, only the change that says so can', () => {
    const plan = planEdit(withNetwork(), { remove: [FIND_TOOL_NAME] }, env);
    expect(plan.ok).toBe(false);
  });
  it('the person\'s instructions survive an edit that adds the network rules', () => {
    const { after } = run({ web: false });
    expect(currentInstructions(after)).toBe('You check suppliers.');
  });
});

// --- the relay: reading a run while it goes on, and bringing an older agent up to date --------------------------
import { beforeEach } from 'vitest';
import { RelayRefusal, WorkflowRelay, type WorkflowBinding } from '@/lib/n8n/relay';
import { FakeMcp } from './helpers/fakeMcp';

describe('WorkflowRelay: S6', () => {
  let mcp: FakeMcp;
  let relay: WorkflowRelay;
  const reads: string[] = [];
  const rest = (raw: unknown) => ({ get: async (id: string) => (reads.push(id), raw) });
  const bind = (): WorkflowBinding => ({ workflowId: 'wf-1', remember: async () => undefined, workflowName: () => 'Supplier Check · 11111111' });
  const nodesWithNetwork = withNetwork().nodes;
  const running = (workflowId: string | undefined, runData: unknown) => ({ id: '9', status: 'running', finished: false, ...(workflowId ? { workflowId } : {}), data: { resultData: { runData } }, workflowData: { nodes: nodesWithNetwork } });

  beforeEach(() => {
    mcp = new FakeMcp();
    mcp.workflow = withNetwork();
    reads.length = 0;
  });

  it('reads a run that has not finished, with the search and the hire so far, in one REST call', async () => {
    relay = new WorkflowRelay(mcp, bind(), ctx, undefined, rest(running('wf-1', { [FIND_TOOL_NAME]: [{ inputOverride: { ai_tool: [[{ json: { query: 'uk registry' } }]] }, executionIndex: 0, executionTime: 0, startTime: 0 }] })));
    const run = await relay.readRun('9');
    expect(run.status).toBe('running');
    expect(run.calls).toEqual([{ id: `${FIND_TOOL_NAME}#0`, kind: 'search', tool: FIND_TOOL_NAME, state: 'calling', query: 'uk registry' }]);
    expect(reads).toEqual(['9']);
    expect(mcp.calls.map((c) => c.name)).not.toContain('get_workflow_execution');
  });
  it('refuses a run of another workflow, and one that does not say whose it is', async () => {
    relay = new WorkflowRelay(mcp, bind(), ctx, undefined, rest(running('someone-elses', {})));
    await expect(relay.readRun('9')).rejects.toThrow(RelayRefusal);
    relay = new WorkflowRelay(mcp, bind(), ctx, undefined, rest(running(undefined, {})));
    await expect(relay.readRun('9')).rejects.toThrow(/another agent/);
  });
  it('does not count the free search as a helper that did not answer', async () => {
    const done = { ...running('wf-1', {}), status: 'success', finished: true };
    done.data = { resultData: { runData: { 'AI step': [{ data: { main: [[{ json: { output: 'Nothing found.', intermediateSteps: [{ action: { tool: 'Find_agents' }, observation: '[]' }] } }]] } }], Answer: [{ data: { main: [[{ json: { output: 'Nothing found.' } }]] } }] } } };
    relay = new WorkflowRelay(mcp, bind(), ctx, undefined, rest(done));
    const run = await relay.readRun('9');
    expect(run.helpers).toEqual([]);
    expect(run.status).toBe('success');
  });
  it('falls back to MCP, after the run, when no REST reader is set', async () => {
    relay = new WorkflowRelay(mcp, bind(), ctx);
    const run = await relay.readRun('9');
    expect(run.status).toBe('running');
    expect(mcp.calls.map((c) => c.name)).toContain('get_workflow_execution');
  });

  describe('an edit also turns on saving progress, for an agent built before S6', () => {
    const old = () => {
      const wf = goodWorkflow();
      wf.settings = { executionOrder: 'v1', availableInMCP: true };
      mcp.workflow = wf;
    };
    it('rewrites the settings once, keeping the steps', async () => {
      old();
      const writes: unknown[] = [];
      const writer = { create: async () => 'x', replace: async (_id: string, body: unknown) => void writes.push(body) };
      relay = new WorkflowRelay(mcp, bind(), ctx, writer);
      await relay.applyEdit({ instructions: 'New.' }, 'Zynd · ada-x7k2');
      expect(writes).toHaveLength(1);
      const body = writes[0] as { settings: Record<string, unknown>; nodes: N8nNode[] };
      expect(body.settings).toMatchObject({ saveExecutionProgress: true, executionOrder: 'v1' });
      expect(hasNetworkSteps(body.nodes)).toBe(true);
    });
    it('does nothing when progress is already saved, and never fails the edit when it cannot be written', async () => {
      mcp.workflow = goodWorkflow();
      const writes: unknown[] = [];
      relay = new WorkflowRelay(mcp, bind(), ctx, { create: async () => 'x', replace: async (_id, body) => void writes.push(body) });
      await relay.applyEdit({ instructions: 'New.' }, 'Zynd · ada-x7k2');
      expect(writes).toEqual([]);
      old();
      relay = new WorkflowRelay(mcp, bind(), ctx, { create: async () => 'x', replace: async () => Promise.reject(new Error('n8n is down')) });
      await expect(relay.applyEdit({ instructions: 'Newer.' }, 'Zynd · ada-x7k2')).resolves.toBeTruthy();
    });
  });
});

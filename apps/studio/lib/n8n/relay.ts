// The only way Studio reaches n8n's MCP server on behalf of one agent (plan, "Guard rails"). The token belongs to
// the instance owner and can change anything, so every call passes through here:
//   - only tools on an allow-list, with only the arguments each needs;
//   - a workflow id must be this agent's own, and a new workflow is created only while the agent has none;
//   - after every create or update the workflow is read back, its Zynd and OpenAI steps are given the right
//     credentials (n8n picks one by type, not by the name asked for), and it is checked by `checkWorkflow`; the same
//     check runs again right before a run or a publish, so nothing unchecked ever executes.
// Publish, unpublish and archive are never offered to the model: Studio calls them itself from buttons.
import { planEdit, currentInstructions, toolsOf, type AgentEdit, type ToolInfo } from '../builder/edit';
import { NODE } from '../builder/template';
import { checkWorkflow, credentialFixes, type N8nNode, type N8nWorkflow, type PolicyContext, type PolicyResult } from './policy';
import { parseExecution, parseRequest, toolKey, type RunView } from './runs';

export interface McpLike {
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** A call Studio refused. The message is safe to show the builder model, and says what to do instead. */
export class RelayRefusal extends Error {
  constructor(message: string, readonly problems: string[] = []) {
    super(message);
    this.name = 'RelayRefusal';
  }
}

export interface WorkflowBinding {
  /** The agent's own workflow, or null while it has none. Kept up to date by the relay. */
  workflowId: string | null;
  /** Saves a new workflow id on the agent's listing. */
  remember(workflowId: string): Promise<void>;
  /** The workflow's name in n8n. */
  workflowName(): string;
}

/** What the builder model may call, and which arguments each takes. */
const MODEL_TOOLS: Record<string, readonly string[]> = {
  search_nodes: ['queries', 'usage'],
  get_node_types: ['nodeIds'],
  get_workflow_sdk_reference: ['section'],
  get_workflow_best_practices: ['technique'],
  validate_workflow: ['code'],
  create_workflow_from_code: ['code', 'description', 'versionName', 'versionDescription'],
  update_workflow: ['operations', 'versionName', 'versionDescription'],
  get_workflow_details: [],
};
export const MODEL_TOOL_NAMES = Object.keys(MODEL_TOOLS);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const pick = (args: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

const asWorkflow = (raw: unknown): N8nWorkflow => {
  const wf = isObj(raw) && isObj(raw.workflow) ? raw.workflow : isObj(raw) ? raw : null;
  if (!wf || !Array.isArray(wf.nodes)) throw new RelayRefusal('n8n did not return the workflow');
  return {
    ...(typeof wf.id === 'string' ? { id: wf.id } : {}),
    ...(typeof wf.active === 'boolean' ? { active: wf.active } : {}),
    ...(typeof wf.versionId === 'string' ? { versionId: wf.versionId } : {}),
    ...(typeof wf.activeVersionId === 'string' || wf.activeVersionId === null ? { activeVersionId: wf.activeVersionId } : {}),
    nodes: wf.nodes as N8nNode[],
    ...(isObj(wf.connections) ? { connections: wf.connections as N8nWorkflow['connections'] } : {}),
    ...(isObj(wf.settings) ? { settings: wf.settings } : {}),
  };
};

export class WorkflowRelay {
  constructor(
    private readonly mcp: McpLike,
    private readonly bind: WorkflowBinding,
    private readonly ctx: PolicyContext,
  ) {}

  get workflowId(): string | null {
    return this.bind.workflowId;
  }

  private own(): string {
    if (!this.bind.workflowId) throw new RelayRefusal('This agent has no workflow yet. Create it with create_workflow_from_code first.');
    return this.bind.workflowId;
  }

  /** The workflow as n8n holds it now. */
  async details(id: string = this.own()): Promise<N8nWorkflow> {
    return asWorkflow(await this.mcp.callTool('get_workflow_details', { workflowId: id }));
  }

  /**
   * Reads the workflow back and sets the right credential on every Zynd and OpenAI step that has another one or none.
   * Returns the workflow as it is afterwards.
   */
  async pinCredentials(id: string = this.own()): Promise<N8nWorkflow> {
    const wf = await this.details(id);
    const operations = credentialFixes(wf, this.ctx);
    if (operations.length === 0) return wf;
    await this.mcp.callTool('update_workflow', { workflowId: id, operations, versionName: 'Studio credentials' });
    return this.details(id);
  }

  async check(): Promise<PolicyResult> {
    return checkWorkflow(await this.details(), this.ctx);
  }

  /** Throws unless the workflow is both safe and a finished agent. Called before every run and publish. */
  async assertRunnable(): Promise<N8nWorkflow> {
    const wf = await this.details();
    const r = checkWorkflow(wf, this.ctx);
    if (r.blocked.length > 0) throw new RelayRefusal('This agent contains something that is not allowed, so it was not run.', r.blocked);
    if (r.missing.length > 0) throw new RelayRefusal('This agent is not finished yet, so it was not run.', r.missing);
    return wf;
  }

  /** One call from the builder model. Anything not on the allow-list, or aimed at another workflow, is refused. */
  async callForModel(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const allowed = MODEL_TOOLS[tool];
    if (!allowed) throw new RelayRefusal(`The tool "${tool}" is not available to you.`);
    const given = args.workflowId;
    if (given !== undefined && given !== this.bind.workflowId) {
      throw new RelayRefusal('That workflow is not this agent\'s. You can only work on the agent you are building.');
    }
    switch (tool) {
      case 'create_workflow_from_code':
        return this.create(pick(args, allowed));
      case 'update_workflow':
        return this.update(pick(args, allowed));
      case 'get_workflow_details': {
        const wf = await this.details();
        // What the model needs to edit the workflow: no ids, no credential details.
        return {
          nodes: wf.nodes.map((n) => ({ name: n.name, type: n.type, typeVersion: n.typeVersion, disabled: n.disabled ?? false, parameters: n.parameters ?? {} })),
          connections: wf.connections ?? {},
        };
      }
      default:
        return this.mcp.callTool(tool, pick(args, allowed));
    }
  }

  private async create(args: Record<string, unknown>): Promise<unknown> {
    if (this.bind.workflowId) throw new RelayRefusal('This agent already has a workflow. Change it with update_workflow instead.');
    if (typeof args.code !== 'string' || !args.code.trim()) throw new RelayRefusal('Send the workflow code in "code".');
    const res = await this.mcp.callTool('create_workflow_from_code', { ...args, name: this.bind.workflowName() });
    const id = isObj(res) && typeof res.workflowId === 'string' ? res.workflowId : undefined;
    if (!id) throw new RelayRefusal('n8n did not confirm that the workflow was created. Try again.');

    // Read it back before keeping it: a workflow with anything not allowed is archived at once and never saved.
    let result: PolicyResult;
    try {
      result = checkWorkflow(await this.pinCredentials(id), this.ctx);
    } catch (err) {
      await this.mcp.callTool('archive_workflow', { workflowId: id }).catch(() => undefined);
      throw err;
    }
    if (result.blocked.length > 0) {
      await this.mcp.callTool('archive_workflow', { workflowId: id }).catch(() => undefined);
      throw new RelayRefusal('The workflow was not saved because it contains something that is not allowed. Fix the code and create it again.', result.blocked);
    }
    await this.bind.remember(id);
    this.bind.workflowId = id;
    await this.mcp.callTool('update_workflow', { workflowId: id, operations: [{ type: 'addTags', names: ['zynd-studio'] }] }).catch(() => undefined);
    return { saved: true, problems: result.missing, ...(result.missing.length ? { next: 'Fix these with update_workflow before testing.' } : {}) };
  }

  private async update(args: Record<string, unknown>): Promise<unknown> {
    const workflowId = this.own();
    if (!Array.isArray(args.operations) || args.operations.length === 0) throw new RelayRefusal('Send the changes in "operations".');
    await this.mcp.callTool('update_workflow', { ...args, workflowId });
    const r = checkWorkflow(await this.pinCredentials(workflowId), this.ctx);
    // The edit is saved in the draft, but a workflow with anything not allowed is never run or published.
    if (r.blocked.length > 0) return { saved: true, usable: false, problems: r.blocked, next: 'Undo or fix these with update_workflow. The agent cannot run until they are gone.' };
    return { saved: true, usable: r.missing.length === 0, problems: r.missing };
  }

  /** What the agent does and the tools it has, as the builder may read them (no ids, no credential details). */
  async setup(): Promise<{ instructions: string | null; tools: ToolInfo[] }> {
    const wf = await this.details();
    return { instructions: currentInstructions(wf), tools: toolsOf(wf) };
  }

  /**
   * One change to the agent as a whole: new instructions, helpers or data sources to add, tools to take away. Studio
   * writes the operations (ids, credentials, payment limits), n8n applies them atomically, and the result is checked.
   */
  async applyEdit(edit: AgentEdit, zyndCredentialName: string): Promise<{ result: unknown; tools: ToolInfo[] }> {
    this.own();
    const plan = planEdit(await this.details(), edit, {
      listingId: this.ctx.listingId,
      zyndCredential: { id: this.ctx.zyndCredentialId, name: zyndCredentialName },
      maxCallPriceUsd: this.ctx.maxCallPriceUsd,
    });
    if (!plan.ok) throw new RelayRefusal(plan.error);
    return { result: await this.update({ operations: plan.operations, versionName: 'Changed by chat' }), tools: plan.tools };
  }

  /**
   * Whether this agent is turned on with a newer saved version than the one running: a change that has been made but
   * is not live yet. `undefined` when n8n did not say.
   */
  async draftAhead(): Promise<boolean | undefined> {
    const wf = await this.details();
    if (wf.active !== true) return false;
    if (!wf.versionId || wf.activeVersionId === undefined) return undefined;
    return wf.versionId !== wf.activeVersionId;
  }

  /** Starts one chat run of this agent and returns its execution id. */
  async startRun(chatInput: string, mode: 'manual' | 'production'): Promise<string> {
    const workflowId = this.own();
    await this.assertRunnable();
    const res = await this.mcp.callTool('execute_workflow', { workflowId, executionMode: mode, triggerNodeName: NODE.chat, inputs: { chatInput } });
    const id = isObj(res) && res.executionId != null ? String(res.executionId) : undefined;
    if (!id) {
      const reason = isObj(res) && typeof res.error === 'string' ? res.error : 'n8n did not start the run';
      throw new RelayRefusal(reason.slice(0, 200));
    }
    return id;
  }

  /** One run of this agent, as the UI may show it. */
  async readRun(executionId: string): Promise<RunView & { request?: string }> {
    const workflowId = this.own();
    const raw = await this.mcp.callTool('get_workflow_execution', { workflowId, executionId, includeData: true, nodeNames: [NODE.request, NODE.ai, NODE.answer] });
    const execution = isObj(raw) && isObj(raw.execution) ? raw.execution : {};
    if (execution.workflowId !== undefined && String(execution.workflowId) !== workflowId) throw new RelayRefusal('That run belongs to another agent.');
    const wf = await this.details();
    const paid = new Set(wf.nodes.filter((n) => n.type === 'CUSTOM.zyndTool' || n.type === 'CUSTOM.zyndAirnodeTool').map((n) => toolKey(n.name)));
    const request = parseRequest(raw);
    return { ...parseExecution(raw, paid), ...(request ? { request } : {}) };
  }

  /** The agent's chat runs, newest first (id, status, start time). In-app runs only: the Zynd Trigger's are tasks at the Gateway. */
  async listRuns(limit = 15): Promise<{ id: string; status: string; startedAt: string }[]> {
    const workflowId = this.own();
    const res = await this.mcp.callTool('search_workflow_executions', { workflowId, limit: Math.min(limit * 2, 50) });
    const rows = isObj(res) && Array.isArray(res.data) ? res.data : [];
    return rows
      .filter((r): r is Record<string, unknown> => isObj(r) && (r.mode === 'chat' || r.mode === 'manual'))
      .slice(0, limit)
      .map((r) => ({ id: String(r.id), status: String(r.status), startedAt: String(r.startedAt ?? '') }));
  }

  /** Turns the workflow on. The Zynd Trigger binds its webhook, and the Gateway registers the listing. */
  async publish(): Promise<void> {
    const workflowId = this.own();
    await this.assertRunnable();
    const res = await this.mcp.callTool('publish_workflow', { workflowId });
    if (isObj(res) && res.success === false) throw new RelayRefusal('n8n could not turn the agent on');
  }

  async unpublish(): Promise<void> {
    await this.mcp.callTool('unpublish_workflow', { workflowId: this.own() });
  }

  async archive(): Promise<void> {
    await this.mcp.callTool('archive_workflow', { workflowId: this.own() });
  }
}

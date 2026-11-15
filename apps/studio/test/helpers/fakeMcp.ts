import type { McpLike } from '../../lib/n8n/relay';
import { McpError } from '../../lib/n8n/mcp';
import type { N8nWorkflow } from '../../lib/n8n/policy';
import { goodWorkflow } from './readback';

export interface Call {
  name: string;
  args: Record<string, unknown>;
}

/** A stand-in for n8n's MCP server: one workflow, a few executions, and a log of every call it received. */
export class FakeMcp implements McpLike {
  calls: Call[] = [];
  /** The workflow `get_workflow_details` returns, or null when none exists yet. */
  workflow: N8nWorkflow | null = null;
  /** The workflow a new `create_workflow_from_code` produces. */
  created: N8nWorkflow = goodWorkflow();
  /** Applied to `workflow` on every `update_workflow`. */
  onUpdate: ((wf: N8nWorkflow, args: Record<string, unknown>) => void) | undefined;
  executions = new Map<string, unknown>();
  nextExecution = 100;
  executeReply: ((args: Record<string, unknown>) => unknown) | undefined;
  failTool: Record<string, string> = {};
  searchResults: unknown = { data: [] };

  callsTo(name: string): Call[] {
    return this.calls.filter((c) => c.name === name);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ name, args });
    if (this.failTool[name]) throw new McpError(this.failTool[name] as string);
    switch (name) {
      case 'create_workflow_from_code':
        this.workflow = structuredClone(this.created);
        return { workflowId: 'wf-1', name: args.name, nodeCount: this.workflow.nodes.length };
      case 'get_workflow_details':
        if (!this.workflow) throw new McpError('Workflow not found');
        return { workflow: this.workflow };
      case 'update_workflow':
        if (this.workflow) this.onUpdate?.(this.workflow, args);
        return { success: true };
      case 'execute_workflow': {
        if (this.executeReply) return this.executeReply(args);
        const id = String(this.nextExecution++);
        return { executionId: id, status: 'started' };
      }
      case 'get_workflow_execution':
        return this.executions.get(String(args.executionId)) ?? { execution: { id: String(args.executionId), status: 'running' } };
      case 'search_workflow_executions':
        return this.searchResults;
      case 'publish_workflow':
        return { success: true, workflowId: args.workflowId, activeVersionId: 'v1' };
      case 'unpublish_workflow':
      case 'archive_workflow':
        return { success: true };
      case 'list_credentials':
        return { data: [] };
      default:
        return { ok: true, tool: name };
    }
  }
}

/** A finished execution as n8n reports it. */
export function finishedRun(opts: { answer?: string; steps?: unknown[]; request?: string; status?: string; workflowId?: string; error?: string } = {}): unknown {
  const { answer = 'All good.', steps = [], request = 'Check ACME', status = 'success', workflowId = 'wf-1', error } = opts;
  return {
    execution: { id: '1', workflowId, mode: 'manual', status, startedAt: '2026-11-16T10:00:00.000Z' },
    data: {
      resultData: {
        runData: {
          Request: [{ data: { main: [[{ json: { request } }]] } }],
          'AI step': [{ data: { main: [[{ json: { output: answer, intermediateSteps: steps } }]] } }],
          ...(answer ? { Answer: [{ data: { main: [[{ json: { output: answer } }]] } }] } : {}),
        },
        ...(error ? { error: { message: error } } : {}),
      },
    },
    resumeToken: 'never-forwarded',
  };
}

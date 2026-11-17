// The whole agent as n8n workflow JSON, written by Studio (S5.1). The builder model only says *what* the agent is
// (instructions, helpers, data sources, the web reader); Studio writes every step, id, credential, payment limit and
// connection here, so nothing the model types can break the shape. Same shape as `renderTemplate` (the SDK version
// kept for reference and tests) and the same tool steps as an edit (`helperNode`, `sourceNode`, `webNode`).
// Pure functions: no network.
import type { DataSource } from '../env';
import type { ConnectionList, N8nNode, N8nWorkflow } from '../n8n/policy';
import type { HelperCard } from '../registry';
import { helperNode, line, sourceNode, toolLine, uniqueName, webNode, WEB_TOOL_NAME, type ToolInfo } from './edit';
import { NODE, composeSystemMessage } from './template';

/** What the agent is. Everything else is Studio's. */
export interface AgentSpec {
  instructions: string;
  helpers: { card: HelperCard; input: 'text' | 'json'; fields?: string }[];
  sources: DataSource[];
  web: boolean;
}

export interface RenderEnv {
  listingId: string;
  /** The workflow's name in n8n. */
  name: string;
  /** The one model agents run on. */
  model: string;
  zyndCredential: { id: string; name: string };
  openAiCredential: { id: string; name: string };
  /** Makes node and webhook ids. Tests pass a counter. */
  newId?: () => string;
}

/** The body n8n's REST API takes for a create or a full update. */
export interface WorkflowBody {
  name: string;
  nodes: N8nNode[];
  connections: NonNullable<N8nWorkflow['connections']>;
  settings: Record<string, unknown>;
}

/** One tool the agent has, with what Studio needs to find it again in a test run. */
export interface RenderedTool extends ToolInfo {
  /** The helper's entity id, or `listingUrl|operation` for a data source, or `web`. */
  ref: string;
  /** For helpers: how it takes its input. */
  input?: 'text' | 'json';
}

export interface RenderedAgent {
  workflow: WorkflowBody;
  tools: RenderedTool[];
  /** The AI step's system message. */
  systemMessage: string;
}

const link = (node: string, type = 'main'): ConnectionList => [[{ node, type, index: 0 }]];

/** Instructions as Studio stores them: trimmed, and never starting with `=` (n8n would read that as an expression). */
export const cleanInstructions = (text: string): string => text.trim().replace(/^=+\s*/, '');

export function renderWorkflowJson(spec: AgentSpec, env: RenderEnv): RenderedAgent {
  const newId = env.newId ?? (() => crypto.randomUUID());
  const taken = new Set<string>([NODE.zynd, NODE.chat, NODE.request, NODE.ai, NODE.answer, NODE.model]);
  const toolEnv = { listingId: env.listingId, zyndCredential: env.zyndCredential };
  const toolNodes: N8nNode[] = [];
  const tools: RenderedTool[] = [];
  let slot = 0;
  const place = (): [number, number] => [480 + 220 * slot++, 360];

  for (const h of spec.helpers) {
    const name = uniqueName(taken, h.card.name);
    toolNodes.push(helperNode(name, { entityId: h.card.entityId, what: h.card.what, priceUsd: h.card.priceUsd, input: h.input, ...(h.fields ? { fields: h.fields } : {}) }, toolEnv, place()));
    tools.push({ name, kind: 'helper', what: line(h.card.what, 300), maxPriceUsd: h.card.priceUsd, ref: h.card.entityId, input: h.input });
  }
  for (const s of spec.sources) {
    const name = uniqueName(taken, s.name);
    toolNodes.push(sourceNode(name, s, toolEnv, place()));
    tools.push({ name, kind: 'data source', what: line(s.what, 300), maxPriceUsd: s.maxPriceUsd, ref: `${s.listingUrl}|${s.operation}` });
  }
  if (spec.web) {
    const name = uniqueName(taken, WEB_TOOL_NAME);
    toolNodes.push(webNode(name, place()));
    tools.push({ name, kind: 'web', what: 'Reads public web pages and open APIs that need no key.', ref: 'web' });
  }

  const systemMessage = composeSystemMessage(cleanInstructions(spec.instructions), tools.map(toolLine));
  const parts: N8nNode[] = [
    {
      name: NODE.zynd,
      type: 'CUSTOM.zyndTrigger',
      typeVersion: 1,
      position: [0, 0],
      webhookId: newId(),
      parameters: { listingId: env.listingId, responseMode: 'lastNode' },
      credentials: { zyndApi: { id: env.zyndCredential.id, name: env.zyndCredential.name } },
    },
    { name: NODE.chat, type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.5, position: [0, 240], webhookId: newId(), parameters: {} },
    {
      name: NODE.request,
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [300, 120],
      parameters: {
        mode: 'manual',
        assignments: {
          assignments: [{ id: 'request', name: 'request', value: "={{ $json.chatInput ?? (typeof $json.input === 'string' ? $json.input : JSON.stringify($json.input ?? {})) }}", type: 'string' }],
        },
        includeOtherFields: false,
      },
    },
    {
      name: NODE.ai,
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
      position: [600, 120],
      parameters: { promptType: 'define', text: '={{ $json.request }}', options: { systemMessage, returnIntermediateSteps: true, maxIterations: 8 } },
    },
    {
      name: NODE.model,
      type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
      typeVersion: 1.3,
      position: [480, 360 + 200],
      parameters: { model: { __rl: true, mode: 'id', value: env.model } },
      credentials: { openAiApi: { id: env.openAiCredential.id, name: env.openAiCredential.name } },
    },
    ...toolNodes,
    {
      name: NODE.answer,
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [900, 120],
      parameters: { mode: 'manual', assignments: { assignments: [{ id: 'output', name: 'output', value: '={{ $json.output }}', type: 'string' }] }, includeOtherFields: false },
    },
  ];
  const nodes = parts.map((n): N8nNode => ({ id: newId(), ...n }));

  const connections: WorkflowBody['connections'] = {
    [NODE.zynd]: { main: link(NODE.request) },
    [NODE.chat]: { main: link(NODE.request) },
    [NODE.request]: { main: link(NODE.ai) },
    [NODE.ai]: { main: link(NODE.answer) },
    [NODE.model]: { ai_languageModel: link(NODE.ai, 'ai_languageModel') },
  };
  for (const n of toolNodes) connections[n.name] = { ai_tool: link(NODE.ai, 'ai_tool') };

  return { workflow: { name: env.name, nodes, connections, settings: { executionOrder: 'v1', availableInMCP: true } }, tools, systemMessage };
}

/**
 * The same agent written over an existing workflow: steps that keep their name keep n8n's ids, so a live agent's
 * Zynd Trigger keeps its webhook and its listing binding.
 */
export function keepIds(next: WorkflowBody, current: N8nWorkflow): WorkflowBody {
  const old = new Map(current.nodes.map((n) => [n.name, n]));
  return {
    ...next,
    nodes: next.nodes.map((n) => {
      const before = old.get(n.name);
      if (!before || before.type !== n.type) return n;
      return { ...n, ...(before.id ? { id: before.id } : {}), ...(before.webhookId ? { webhookId: before.webhookId } : {}) };
    }),
  };
}

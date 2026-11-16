// The guard rail on what a Studio agent's workflow may contain (plan, "Guard rails"). The n8n MCP token can change
// anything on the instance, so after every create or update Studio reads the workflow back and runs this check, and
// it runs again right before the workflow is executed or published. Pure functions: no network, easy to test.
import { NODE } from '../builder/template';
import type { DataSource } from '../env';

export interface N8nNode {
  name: string;
  type: string;
  typeVersion?: number;
  disabled?: boolean;
  position?: [number, number];
  parameters?: Record<string, unknown>;
  credentials?: Record<string, { id?: string | null; name?: string | null } | undefined>;
}

/** One kind of connection out of a step: a list of outputs, each a list of the steps it feeds. */
export type ConnectionList = ({ node: string; type?: string; index?: number }[] | null)[];

export interface N8nWorkflow {
  id?: string;
  name?: string;
  /** Turned on (published). */
  active?: boolean;
  /** The newest saved version, and the one that is running. They differ while a live agent has changes not yet published. */
  versionId?: string;
  activeVersionId?: string | null;
  nodes: N8nNode[];
  connections?: Record<string, Partial<Record<string, ConnectionList>>>;
  settings?: Record<string, unknown>;
}

export interface PolicyContext {
  /** This agent's own listing: the only one the trigger may serve and the only wallet that may pay. */
  listingId: string;
  /** The user's Zynd credential in n8n. */
  zyndCredentialId: string;
  /** The platform's OpenAI credential in n8n. */
  openAiCredentialId: string;
  /** The one model an agent may run on. */
  agentModel: string;
  /** The data sources the builder may offer; an AirnodeHub tool must match one of them. */
  dataSources: DataSource[];
  /** The most one helper or data-source call may cost, USD. */
  maxCallPriceUsd: string;
}

export interface PolicyResult {
  /** Reasons the workflow must not run or be published. Written for the builder model to act on. */
  blocked: string[];
  /** Parts of the template that are missing. The workflow is safe but not a finished agent. */
  missing: string[];
}

const T = {
  zyndTrigger: 'CUSTOM.zyndTrigger',
  zyndTool: 'CUSTOM.zyndTool',
  airnodeTool: 'CUSTOM.zyndAirnodeTool',
  chatTrigger: '@n8n/n8n-nodes-langchain.chatTrigger',
  agent: '@n8n/n8n-nodes-langchain.agent',
  openAiModel: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  httpTool: 'n8n-nodes-base.httpRequestTool',
} as const;

/** Every kind of step an agent may contain. Code, Execute Command, SSH, file and database steps are never here. */
export const ALLOWED_NODE_TYPES: readonly string[] = [
  T.zyndTrigger,
  T.chatTrigger,
  'n8n-nodes-base.set',
  'n8n-nodes-base.if',
  'n8n-nodes-base.switch',
  'n8n-nodes-base.merge',
  'n8n-nodes-base.filter',
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.stickyNote',
  T.agent,
  T.openAiModel,
  T.zyndTool,
  T.airnodeTool,
  T.httpTool,
  '@n8n/n8n-nodes-langchain.toolThink',
  '@n8n/n8n-nodes-langchain.toolCalculator',
  '@n8n/n8n-nodes-langchain.outputParserStructured',
];

const MAX_NODES = 30;
const ENTITY_ID = /^zns:[A-Za-z0-9_-]{8,80}$/;
const USD = /^\d{1,4}(\.\d{1,6})?$/;

const isLiteral = (v: unknown): v is string => typeof v === 'string' && !v.startsWith('=');
const param = (n: N8nNode, k: string): unknown => n.parameters?.[k];

/** Hosts a public-web tool must not be pointed at when the address is written into the workflow. */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return true;
  if (h.includes(':')) return true; // an IPv6 literal: never a public web page for a non-developer's agent
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

const sameCredential = (c: { id?: string | null } | undefined, id: string) => Boolean(c?.id) && c?.id === id;

function checkPayment(n: N8nNode, label: string, ctx: PolicyContext, out: string[]): void {
  if (param(n, 'payFrom') !== 'listing' || param(n, 'payFromListingId') !== ctx.listingId) {
    out.push(`${label} must pay from this agent's own wallet: set payFrom to "listing" and payFromListingId to "${ctx.listingId}".`);
  }
  const max = param(n, 'maxPaymentUsd');
  if (!isLiteral(max) || !USD.test(max)) out.push(`${label} needs a fixed maxPaymentUsd such as "0.05" (not an expression).`);
  else if (Number(max) > Number(ctx.maxCallPriceUsd)) out.push(`${label} may cost at most $${ctx.maxCallPriceUsd} per call; maxPaymentUsd is ${max}.`);
}

/** Checks one workflow as read back from n8n. */
export function checkWorkflow(wf: N8nWorkflow, ctx: PolicyContext): PolicyResult {
  const blocked: string[] = [];
  const missing: string[] = [];
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];

  if (nodes.length > MAX_NODES) blocked.push(`The agent has ${nodes.length} steps; at most ${MAX_NODES} are allowed.`);
  if (wf.settings?.errorWorkflow) blocked.push('Remove the error workflow setting: agents may not trigger other workflows.');

  for (const n of nodes) {
    const label = `Step "${n.name}"`;
    if (!ALLOWED_NODE_TYPES.includes(n.type)) {
      blocked.push(`${label} is of kind "${n.type}", which is not allowed. Remove it. Allowed kinds: ${ALLOWED_NODE_TYPES.join(', ')}.`);
      continue; // no point checking the rest of a step that has to go
    }

    // Credentials: a step may only carry the credential its own kind needs, and only the right one.
    const wanted: Record<string, string> =
      n.type === T.zyndTrigger || n.type === T.zyndTool || n.type === T.airnodeTool
        ? { zyndApi: ctx.zyndCredentialId }
        : n.type === T.openAiModel
          ? { openAiApi: ctx.openAiCredentialId }
          : {};
    for (const [type, c] of Object.entries(n.credentials ?? {})) {
      if (!c) continue;
      const id = wanted[type];
      if (id === undefined) blocked.push(`${label} uses a credential of type "${type}", which is not allowed here. Remove it.`);
      else if (!sameCredential(c, id)) blocked.push(`${label} uses a credential that does not belong to this agent. Use newCredential with the exact name given in the template.`);
    }
    for (const type of Object.keys(wanted)) {
      if (!sameCredential(n.credentials?.[type], wanted[type] as string)) missing.push(`${label} has no ${type} credential assigned.`);
    }

    switch (n.type) {
      case T.zyndTrigger: {
        if (param(n, 'listingId') !== ctx.listingId) blocked.push(`${label} must serve this agent only: listingId "${ctx.listingId}".`);
        const extra = param(n, 'additionalListingIds');
        if (Array.isArray(extra) && extra.length > 0) blocked.push(`${label} must not serve extra listings.`);
        const mode = param(n, 'responseMode');
        if (mode !== undefined && mode !== 'lastNode') missing.push(`${label} must answer when the last step finishes (responseMode "lastNode").`);
        break;
      }
      case T.chatTrigger:
        if (param(n, 'public') === true) blocked.push(`${label} must not be public: anyone with the link could spend this agent's credit.`);
        break;
      case T.zyndTool: {
        if (param(n, 'operation') !== 'callAgent') blocked.push(`${label} may only use operation "callAgent".`);
        const agentId = param(n, 'agentId');
        if (!isLiteral(agentId) || !ENTITY_ID.test(agentId)) blocked.push(`${label} must hire one fixed helper: set agentId to its "zns:…" id, not an expression.`);
        checkPayment(n, label, ctx, blocked);
        break;
      }
      case T.airnodeTool: {
        if (param(n, 'operation') !== 'call') blocked.push(`${label} may only use operation "call".`);
        const url = param(n, 'listingUrl');
        const op = param(n, 'airnodeOperation');
        const known = ctx.dataSources.some((s) => s.listingUrl === url && s.operation === op);
        if (!isLiteral(url) || !isLiteral(op) || !known) blocked.push(`${label} must use one of the offered data sources exactly (listingUrl and airnodeOperation both fixed).`);
        checkPayment(n, label, ctx, blocked);
        break;
      }
      case T.httpTool: {
        const method = param(n, 'method');
        if (method !== undefined && method !== 'GET') blocked.push(`${label} may only read (method GET).`);
        const auth = param(n, 'authentication');
        if (auth !== undefined && auth !== 'none') blocked.push(`${label} must not use authentication: it is for public pages that need no key.`);
        if (param(n, 'sendBody') === true) blocked.push(`${label} must not send a body.`);
        if (isLiteral(param(n, 'url'))) {
          let host = '';
          try {
            const u = new URL(param(n, 'url') as string);
            if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
            host = u.hostname;
          } catch {
            blocked.push(`${label} has an address that is not a web address.`);
          }
          if (host && isInternalHost(host)) blocked.push(`${label} must not point at an internal address.`);
        }
        if ((param(n, 'options') as Record<string, unknown> | undefined)?.proxy) blocked.push(`${label} must not use a proxy.`);
        break;
      }
      case T.openAiModel: {
        const model = (param(n, 'model') as { value?: unknown } | undefined)?.value;
        if (model !== undefined && model !== ctx.agentModel) blocked.push(`${label} must use the model "${ctx.agentModel}".`);
        const tools = param(n, 'builtInTools');
        if (tools && typeof tools === 'object' && Object.keys(tools).length > 0) blocked.push(`${label} must not turn on built-in tools.`);
        break;
      }
      case T.agent: {
        const o = param(n, 'options') as { returnIntermediateSteps?: unknown } | undefined;
        if (n.name === NODE.ai && o?.returnIntermediateSteps !== true) missing.push(`${label} must have "returnIntermediateSteps" on: Studio needs it to show what the agent used.`);
        break;
      }
    }
  }

  // The finished shape (plan, "Agent workflow template").
  const named = (name: string, type?: string) => nodes.find((n) => n.name === name && (type === undefined || n.type === type));
  const zynd = nodes.filter((n) => n.type === T.zyndTrigger);
  if (zynd.length === 0) missing.push(`Add the Zynd Trigger step ("${NODE.zynd}") for this agent's listing.`);
  if (zynd.length > 1) blocked.push('Only one Zynd Trigger step is allowed.');
  if (!named(NODE.chat, T.chatTrigger)) missing.push(`Keep the Chat Trigger step named "${NODE.chat}": the app uses it.`);
  if (!named(NODE.request)) missing.push(`Keep the step named "${NODE.request}".`);
  if (!named(NODE.ai, T.agent)) missing.push(`Keep the AI agent step named "${NODE.ai}".`);
  if (!named(NODE.answer, 'n8n-nodes-base.set')) missing.push(`Keep the last step, a Set step named "${NODE.answer}", that outputs the field "output".`);
  for (const t of [NODE.zynd, NODE.chat]) {
    const out = wf.connections?.[t]?.main?.[0];
    if (named(t) && !(out && out.length > 0)) missing.push(`"${t}" is not connected to anything.`);
  }
  return { blocked, missing };
}

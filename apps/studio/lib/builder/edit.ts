// Changing an agent that already exists (S4.1). The builder model could write n8n's raw edit operations itself, but
// the fiddly parts (credential ids, payment limits, the `$fromAI` expressions, how a tool plugs into the AI step) are
// exactly what must never be wrong, so Studio writes them. The model says *what* should change (new instructions,
// a helper to add, a tool to remove) and `planEdit` turns that into one atomic list of operations for `update_workflow`.
// Pure functions: no network, easy to test. The relay still reads the workflow back and checks it afterwards.
import type { DataSource } from '../env';
import type { N8nNode, N8nWorkflow } from '../n8n/policy';
import type { HelperCard } from '../registry';
import { NODE, composeSystemMessage, instructionsOf } from './template';

export const TOOL_TYPES = {
  helper: 'CUSTOM.zyndTool',
  source: 'CUSTOM.zyndAirnodeTool',
  web: 'n8n-nodes-base.httpRequestTool',
} as const;

export const WEB_TOOL_NAME = 'Web page reader';
const INSTRUCTIONS_MAX = 1500;

export type ToolKind = 'helper' | 'data source' | 'web';

/** One tool the agent has, as the builder model and the person may hear of it. */
export interface ToolInfo {
  name: string;
  kind: ToolKind;
  /** A short sentence on what it does. */
  what: string;
  /** The most one call may cost, a decimal string. Absent for the web reader. */
  maxPriceUsd?: string;
}

/** What the model asks to change. Every part is optional, but at least one must be given. */
export interface AgentEdit {
  /** New instructions: what the agent does, what it needs and how it answers. Replaces the old ones. */
  instructions?: string;
  addHelpers?: { card: HelperCard; input: 'text' | 'json'; fields?: string }[];
  addSources?: DataSource[];
  /** Names of tools to take away (as `get_agent_setup` lists them). */
  remove?: string[];
  /** true adds the web reader, false removes it. */
  web?: boolean;
}

export interface EditEnv {
  listingId: string;
  zyndCredential: { id: string; name: string };
  /** The most one helper or data-source call may cost, USD. */
  maxCallPriceUsd: string;
}

export type EditPlan = { ok: true; operations: Record<string, unknown>[]; tools: ToolInfo[]; instructions: string } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One short plain line from any text: no braces (n8n would read `{{ }}` as an expression), no line breaks, no quotes. */
const line = (s: string, max: number): string =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[{}'"`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^=+\s*/, '')
    .slice(0, max);

/** The text of a fixed `$fromAI` hint: letters, digits and a little punctuation only. */
const hint = (s: string): string =>
  s
    .replace(/[^\p{L}\p{N} ,.:()\-_/]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

/** The same expression text n8n's own builder writes (and reads back) for a value the AI fills in. */
const fromAi = (key: string, description: string): string => `={{ /*n8n-auto-generated-fromAI-override*/ $fromAI('${key}', '${hint(description)}') }}`;

const param = (n: N8nNode, k: string): unknown => n.parameters?.[k];

/** The tools the agent has now, read from the workflow. */
export function toolsOf(wf: N8nWorkflow): ToolInfo[] {
  const out: ToolInfo[] = [];
  for (const n of wf.nodes) {
    // The how-to-call sentence Studio appends to a helper's description belongs to the tool, not to the system message.
    const described = typeof param(n, 'toolDescription') === 'string' ? line((param(n, 'toolDescription') as string).replace(/\s*Send a (?:JSON object|short plain-text request)[^.]*\.\s*$/, ''), 140) : '';
    const max = typeof param(n, 'maxPaymentUsd') === 'string' ? (param(n, 'maxPaymentUsd') as string) : undefined;
    if (n.type === TOOL_TYPES.helper) out.push({ name: n.name, kind: 'helper', what: described, ...(max ? { maxPriceUsd: max } : {}) });
    else if (n.type === TOOL_TYPES.source) out.push({ name: n.name, kind: 'data source', what: described, ...(max ? { maxPriceUsd: max } : {}) });
    else if (n.type === TOOL_TYPES.web) out.push({ name: n.name, kind: 'web', what: 'Reads public web pages and open APIs that need no key.' });
  }
  return out;
}

/** The AI step's current instructions (the person's own part of its system message), or null when they cannot be read. */
export function currentInstructions(wf: N8nWorkflow): string | null {
  const ai = wf.nodes.find((n) => n.name === NODE.ai);
  const options = ai && isObj(param(ai, 'options')) ? (param(ai, 'options') as Record<string, unknown>) : undefined;
  const message = options?.systemMessage;
  // An expression (`=…`) is something the builder did on purpose and Studio will not rewrite.
  return typeof message === 'string' && !message.startsWith('=') ? instructionsOf(message) : null;
}

const toolLine = (t: ToolInfo): string => (t.kind === 'web' ? 'Web page reader (public pages and APIs that need no key)' : `${t.name} (a ${t.kind === 'helper' ? 'helper agent' : 'data source'}: ${t.what})`);

const uniqueName = (taken: Set<string>, base: string): string => {
  const clean = base.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 40) || 'Helper';
  let name = clean;
  for (let i = 2; taken.has(name); i++) name = `${clean} ${i}`;
  taken.add(name);
  return name;
};

/** Works out the operations for one edit, or says in plain terms why it cannot be done. */
export function planEdit(wf: N8nWorkflow, edit: AgentEdit, env: EditEnv): EditPlan {
  const ai = wf.nodes.find((n) => n.name === NODE.ai);
  if (!ai) return { ok: false, error: `The agent has no step named "${NODE.ai}", so it cannot be edited this way. Use update_workflow.` };
  const asked = Boolean(edit.instructions?.trim()) || Boolean(edit.addHelpers?.length) || Boolean(edit.addSources?.length) || Boolean(edit.remove?.length) || edit.web !== undefined;
  if (!asked) return { ok: false, error: 'Nothing to change. Send new instructions, helpers or data sources to add, tools to remove, or web.' };

  const before = toolsOf(wf);
  const taken = new Set(wf.nodes.map((n) => n.name));
  const operations: Record<string, unknown>[] = [];
  const removed = new Set<string>();

  for (const name of edit.remove ?? []) {
    const tool = before.find((t) => t.name === name);
    if (!tool) return { ok: false, error: `The agent has no tool called "${name}". Its tools are: ${before.map((t) => t.name).join(', ') || 'none'}.` };
    removed.add(name);
    taken.delete(name);
    operations.push({ type: 'removeNode', nodeName: name });
  }

  const hasWeb = before.find((t) => t.kind === 'web');
  if (edit.web === false && hasWeb && !removed.has(hasWeb.name)) {
    removed.add(hasWeb.name);
    taken.delete(hasWeb.name);
    operations.push({ type: 'removeNode', nodeName: hasWeb.name });
  }

  const added: ToolInfo[] = [];
  const have = new Set(wf.nodes.filter((n) => n.type === TOOL_TYPES.helper && !removed.has(n.name)).map((n) => String(param(n, 'agentId'))));
  const haveSources = new Set(wf.nodes.filter((n) => n.type === TOOL_TYPES.source && !removed.has(n.name)).map((n) => `${param(n, 'listingUrl')}|${param(n, 'airnodeOperation')}`));
  const nextY = Math.max(0, ...wf.nodes.map((n) => (Array.isArray(n.position) ? Number(n.position[1]) || 0 : 0))) + 160;
  let slot = 0;
  const place = (): [number, number] => [600 + 220 * slot++, nextY];
  const plug = (name: string) => operations.push({ type: 'addConnection', source: name, target: NODE.ai, connectionType: 'ai_tool' });
  const credentials = { zyndApi: { id: env.zyndCredential.id, name: env.zyndCredential.name } };
  const pay = { payFrom: 'listing', payFromListingId: env.listingId };
  const tooDear = (price: string) => !/^\d{1,4}(\.\d{1,6})?$/.test(price) || Number(price) > Number(env.maxCallPriceUsd);

  for (const h of edit.addHelpers ?? []) {
    if (have.has(h.card.entityId)) return { ok: false, error: `The agent already uses ${h.card.name}.` };
    if (tooDear(h.card.priceUsd)) return { ok: false, error: `${h.card.name} costs more than the most one call may cost ($${env.maxCallPriceUsd}).` };
    const name = uniqueName(taken, h.card.name);
    const what = line(h.card.what, 300);
    const fields = line(h.fields ?? '', 200);
    const how = h.input === 'json' ? `Send a JSON object${fields ? ` with these fields: ${fields}` : ''}.` : 'Send a short plain-text request.';
    have.add(h.card.entityId);
    operations.push({
      type: 'addNode',
      node: {
        name,
        type: TOOL_TYPES.helper,
        typeVersion: 1,
        position: place(),
        parameters: {
          descriptionType: 'manual',
          toolDescription: `${what} ${how}`.slice(0, 500),
          operation: 'callAgent',
          agentId: h.card.entityId,
          ...(h.input === 'json'
            ? { inputType: 'json', inputJson: fromAi('input', `A JSON object for ${name}${fields ? ` with the fields ${fields}` : ''}`) }
            : { inputType: 'text', inputText: fromAi('request', `What to ask ${name}, in plain words`) }),
          maxPaymentUsd: h.card.priceUsd,
          ...pay,
        },
        credentials,
      },
    });
    plug(name);
    added.push({ name, kind: 'helper', what, maxPriceUsd: h.card.priceUsd });
  }

  for (const s of edit.addSources ?? []) {
    if (haveSources.has(`${s.listingUrl}|${s.operation}`)) return { ok: false, error: `The agent already uses ${s.name}.` };
    if (tooDear(s.maxPriceUsd)) return { ok: false, error: `${s.name} costs more than the most one call may cost ($${env.maxCallPriceUsd}).` };
    const name = uniqueName(taken, s.name);
    const what = line(s.what, 300);
    const fields = line(s.fields ?? '', 200);
    haveSources.add(`${s.listingUrl}|${s.operation}`);
    operations.push({
      type: 'addNode',
      node: {
        name,
        type: TOOL_TYPES.source,
        typeVersion: 1,
        position: place(),
        parameters: {
          descriptionType: 'manual',
          toolDescription: `${what}${fields ? ` Parameters: ${fields}.` : ''}`.slice(0, 500),
          operation: 'call',
          listingUrl: s.listingUrl,
          airnodeOperation: s.operation,
          airnodeParameters: fromAi('parameters', `A JSON object of parameters for ${name}${fields ? `: ${fields}` : ''}`),
          maxPaymentUsd: s.maxPriceUsd,
          ...pay,
        },
        credentials,
      },
    });
    plug(name);
    added.push({ name, kind: 'data source', what, maxPriceUsd: s.maxPriceUsd });
  }

  if (edit.web === true && !(hasWeb && !removed.has(hasWeb.name))) {
    const name = uniqueName(taken, WEB_TOOL_NAME);
    operations.push({
      type: 'addNode',
      node: {
        name,
        type: TOOL_TYPES.web,
        typeVersion: 4.5,
        position: place(),
        parameters: { method: 'GET', url: fromAi('url', 'The full https address of a public web page or API that needs no key'), authentication: 'none', optimizeResponse: true, responseType: 'text', truncateResponse: true, maxLength: 6000 },
      },
    });
    plug(name);
    added.push({ name, kind: 'web', what: 'Reads public web pages and open APIs that need no key.' });
  }

  // The AI step's system message always matches the tools it really has, so it never promises one that is gone.
  let instructions = edit.instructions?.trim() ?? '';
  if (instructions.length > INSTRUCTIONS_MAX) return { ok: false, error: `The instructions are too long: ${INSTRUCTIONS_MAX} characters at most.` };
  const old = currentInstructions(wf);
  if (!instructions) {
    if (old === null) {
      if (added.length || removed.size) return { ok: false, error: 'The agent\'s instructions are written as an expression, so Studio cannot update them to match the new tools. Send new "instructions" together with the change.' };
    } else instructions = old;
  }
  const tools = [...before.filter((t) => !removed.has(t.name)), ...added];
  if (instructions) {
    const options = isObj(param(ai, 'options')) ? (param(ai, 'options') as Record<string, unknown>) : {};
    operations.push({ type: 'setNodeParameter', nodeName: NODE.ai, path: '/options', value: { ...options, systemMessage: composeSystemMessage(instructions, tools.map(toolLine)) } });
  }
  return { ok: true, operations, tools, instructions: instructions || (old ?? '') };
}

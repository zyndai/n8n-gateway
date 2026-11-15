// The tools the builder model can call (S2.3, S2.4, S2.6). Two kinds:
//   - Studio's own: find_helpers, list_data_sources, update_preview, get_template, test_agent, progress;
//   - a few n8n tools, only through the guarded relay (allow-listed, this agent's workflow only, checked on read-back).
// Every tool answers with a string and never throws, so one bad call cannot end the conversation. "Ready" is Studio's
// decision, not the model's: `progress("ready")` is refused until a test run has answered since the last change.
import type { DataSource } from '../env';
import type { ToolSpec } from '../openai';
import { McpError } from '../n8n/mcp';
import { MODEL_TOOL_NAMES, RelayRefusal, type WorkflowRelay } from '../n8n/relay';
import { fromMicro, toMicro } from '../n8n/runs';
import type { HelperCard } from '../registry';
import type { Helper } from '../types';
import { BUILD_STEPS, type BuildEvent, type BuildStep, type Preview } from './events';
import { NAME_LIMIT, SUMMARY_LIMIT } from './limits';
import { renderTemplate, type TemplateHelper, type TemplateSource } from './template';

export interface BuilderToolsDeps {
  listing: { id: string; name: string };
  /** Saves the agent's name, description and suggested price on its listing. */
  save(patch: { name: string; summary: string; priceUsd: string }): Promise<unknown>;
  relay: Pick<WorkflowRelay, 'callForModel' | 'startRun' | 'readRun' | 'workflowId'>;
  registry: { search(query: string, limit?: number): Promise<HelperCard[]>; lookup(entityId: string): HelperCard | undefined };
  dataSources: DataSource[];
  agentModel: string;
  zyndCredentialName: string;
  openAiCredentialName: string;
  emit(event: BuildEvent): void;
  log?: Pick<Console, 'warn'>;
  /** How long a test run may take, and how often it is checked. */
  testTimeoutMs?: number;
  pollMs?: number;
  /** Most test runs per conversation turn: each one can spend the agent's credit. */
  maxTests?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface BuilderTools {
  specs: ToolSpec[];
  run(name: string, rawArgs: string): Promise<string>;
}

const OUTPUT_MAX = 14_000;
const DEFAULT_PRICE = '0.10';
const USD = /^\d{1,3}(\.\d{1,6})?$/;
const clip = (s: string) => (s.length > OUTPUT_MAX ? `${s.slice(0, OUTPUT_MAX)}\n…[cut: ${s.length - OUTPUT_MAX} more characters]` : s);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const fail = (error: string, extra: Record<string, unknown> = {}) => JSON.stringify({ error, ...extra });
const ok = (data: unknown) => clip(typeof data === 'string' ? data : JSON.stringify(data));

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
// `strict: false` is stated on purpose: the Responses API makes function tools strict unless told otherwise, and strict
// mode demands every property be required, which these schemas do not (optional arguments are normal).
const fn = (name: string, description: string, parameters: Record<string, unknown>): ToolSpec => ({ type: 'function', name, description, parameters, strict: false });

export const TOOL_SPECS: ToolSpec[] = [
  fn('find_helpers', 'Search the network for other agents your agent could hire. Returns up to six with a short description and the price per use. Use short plain-English queries.', obj({ query: { type: 'string' } }, ['query'])),
  fn('list_data_sources', 'List the data sources an agent may use (each with what it returns and its maximum price per use).', obj({})),
  fn(
    'update_preview',
    'Show the person the agent so far: its name, what it does, the helpers and data sources it uses and a suggested price. Call it whenever any of that changes.',
    obj(
      {
        name: { type: 'string', description: 'A short friendly name, 60 characters at most.' },
        description: { type: 'string', description: `What it does, ${SUMMARY_LIMIT} characters at most.` },
        helper_ids: { type: 'array', items: { type: 'string' }, description: 'Ids returned by find_helpers.' },
        data_sources: { type: 'array', items: { type: 'string' }, description: 'Names returned by list_data_sources.' },
        suggested_price_usd: { type: 'string', description: 'What other agents pay per use, e.g. "0.15".' },
      },
      ['name', 'description'],
    ),
  ),
  fn(
    'get_template',
    'Get the ready-made workflow code for this agent, with the right ids, credentials and payment limits already filled in. Submit it to create_workflow_from_code unchanged unless a plain extra step is needed.',
    obj(
      {
        instructions: { type: 'string', description: 'What the agent does, what it needs in a request and how it should answer, written to the agent. Under 1500 characters.' },
        helpers: {
          type: 'array',
          items: obj(
            {
              id: { type: 'string' },
              input: { type: 'string', enum: ['text', 'json'], description: 'Whether the helper takes plain text or a JSON object.' },
              fields: { type: 'string', description: 'For json helpers: the field names it expects, comma separated.' },
            },
            ['id', 'input'],
          ),
        },
        data_sources: { type: 'array', items: { type: 'string' } },
        web: { type: 'boolean', description: 'Let the agent read public web pages and open APIs that need no key.' },
      },
      ['instructions'],
    ),
  ),
  fn('test_agent', 'Run the agent once with a sample request and wait for its answer. May cost a few cents of the agent\'s credit. Needed before progress("ready").', obj({ question: { type: 'string' } }, ['question'])),
  fn('progress', 'Tell the person which step you are on. "ready" is only accepted after a successful test_agent.', obj({ step: { type: 'string', enum: [...BUILD_STEPS] } }, ['step'])),

  fn('search_nodes', 'Find n8n building blocks by name. Rarely needed: start from get_template.', obj({ queries: { type: 'array', items: { type: 'string' } }, usage: { type: 'string', enum: ['workflow', 'agentTool'] } }, ['queries'])),
  fn('get_node_types', 'Exact parameter definitions for building blocks. Rarely needed.', obj({ nodeIds: { type: 'array', items: { type: 'object', properties: { nodeId: { type: 'string' }, resource: { type: 'string' }, operation: { type: 'string' }, mode: { type: 'string' }, version: { type: 'string' } }, required: ['nodeId'] } } }, ['nodeIds'])),
  fn('get_workflow_sdk_reference', 'The workflow code reference. Large; use a section. Rarely needed.', obj({ section: { type: 'string', enum: ['patterns', 'expressions', 'functions', 'rules', 'guidelines'] } })),
  fn('get_workflow_best_practices', 'Design guidance for a technique. Rarely needed.', obj({ technique: { type: 'string' } }, ['technique'])),
  fn('validate_workflow', 'Check workflow code without saving it.', obj({ code: { type: 'string' } }, ['code'])),
  fn('create_workflow_from_code', 'Save the agent\'s workflow from code (from get_template). Only while the agent has none. Returns problems to fix, if any.', obj({ code: { type: 'string' }, description: { type: 'string' }, versionName: { type: 'string' } }, ['code'])),
  fn('update_workflow', 'Change the agent\'s existing workflow with a list of edit operations. Returns problems to fix, if any.', obj({ operations: { type: 'array', items: { type: 'object' } }, versionName: { type: 'string' } }, ['operations'])),
  fn('get_workflow_details', 'Read the agent\'s current workflow (its steps and how they connect).', obj({})),
];

const PASSTHROUGH = new Set(MODEL_TOOL_NAMES);

export function createBuilderTools(deps: BuilderToolsDeps): BuilderTools {
  let tested = false;
  let testsRun = 0;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const findSources = (names: unknown): DataSource[] | string => {
    const out: DataSource[] = [];
    for (const n of Array.isArray(names) ? names : []) {
      const s = deps.dataSources.find((d) => d.name === n);
      if (!s) return `Unknown data source "${String(n)}". Use a name from list_data_sources.`;
      out.push(s);
    }
    return out;
  };
  const findHelpers = (ids: unknown): HelperCard[] | string => {
    const out: HelperCard[] = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const card = typeof id === 'string' ? deps.registry.lookup(id) : undefined;
      if (!card) return `"${String(id)}" is not a helper you found. Call find_helpers first and use the ids it returns.`;
      out.push(card);
    }
    return out;
  };

  async function updatePreview(a: Record<string, unknown>): Promise<string> {
    const name = str(a.name, NAME_LIMIT);
    const description = str(a.description, SUMMARY_LIMIT + 1);
    if (!name) return fail('Give the agent a name.');
    if (!description || description.length > SUMMARY_LIMIT) return fail(`The description must be 1 to ${SUMMARY_LIMIT} characters.`);
    const helpers = findHelpers(a.helper_ids);
    if (typeof helpers === 'string') return fail(helpers);
    const sources = findSources(a.data_sources);
    if (typeof sources === 'string') return fail(sources);

    let cost = 0n;
    const list: Helper[] = [];
    for (const h of helpers) {
      cost += toMicro(h.priceUsd);
      list.push({ name: h.name, what: h.what.slice(0, 120), priceUsd: h.priceUsd });
    }
    for (const s of sources) {
      cost += toMicro(s.maxPriceUsd);
      list.push({ name: s.name, what: s.what.slice(0, 120), priceUsd: s.maxPriceUsd });
    }
    const asked = str(a.suggested_price_usd, 12);
    const price = USD.test(asked) ? asked : DEFAULT_PRICE;
    const preview: Preview = { name, does: description, helpers: list, costUsd: fromMicro(cost), suggestedPriceUsd: price };

    await deps.save({ name, summary: description, priceUsd: price });
    deps.listing.name = name;
    deps.emit({ type: 'preview', preview });
    return ok({ shown: true, cost_per_use_usd: preview.costUsd });
  }

  function getTemplate(a: Record<string, unknown>): string {
    const instructions = str(a.instructions, 1600);
    if (!instructions) return fail('Write the agent\'s instructions in "instructions".');
    if (instructions.length > 1500) return fail('The instructions are too long: 1500 characters at most.');
    const found = findHelpers((Array.isArray(a.helpers) ? a.helpers : []).map((h) => (isObj(h) ? h.id : undefined)));
    if (typeof found === 'string') return fail(found);
    const sources = findSources(a.data_sources);
    if (typeof sources === 'string') return fail(sources);

    const helpers: TemplateHelper[] = found.map((card, i) => {
      const given = (a.helpers as Record<string, unknown>[])[i] as Record<string, unknown>;
      const fields = str(given.fields, 200);
      return {
        entityId: card.entityId,
        name: card.name,
        what: card.what,
        maxPriceUsd: card.priceUsd,
        input: given.input === 'text' ? 'text' : 'json',
        ...(fields ? { fields } : {}),
      };
    });
    const tplSources: TemplateSource[] = sources.map((s) => ({
      name: s.name,
      listingUrl: s.listingUrl,
      operation: s.operation,
      what: s.what,
      maxPriceUsd: s.maxPriceUsd,
      ...(s.fields ? { fields: s.fields } : {}),
    }));
    const code = renderTemplate({
      listingId: deps.listing.id,
      zyndCredentialName: deps.zyndCredentialName,
      openAiCredentialName: deps.openAiCredentialName,
      model: deps.agentModel,
      name: deps.listing.name,
      instructions,
      helpers,
      sources: tplSources,
      web: a.web === true,
    });
    return ok(`Workflow code (submit to create_workflow_from_code unchanged unless a plain extra step is needed):\n\n${code}`);
  }

  async function testAgent(a: Record<string, unknown>): Promise<string> {
    const question = str(a.question, 1500);
    if (!question) return fail('Send a sample request in "question".');
    if (testsRun >= (deps.maxTests ?? 4)) return fail('Enough test runs for now. Tell the person what happened so far.');
    testsRun += 1;
    deps.emit({ type: 'progress', step: 'testing' });
    let id: string;
    try {
      id = await deps.relay.startRun(question, 'manual');
    } catch (err) {
      return describe(err);
    }
    const deadline = Date.now() + (deps.testTimeoutMs ?? 150_000);
    for (;;) {
      await sleep(deps.pollMs ?? 2_000);
      let run;
      try {
        run = await deps.relay.readRun(id);
      } catch (err) {
        return describe(err);
      }
      if (run.status === 'running') {
        if (Date.now() > deadline) return fail('The test took too long.', { kind: 'timeout' });
        continue;
      }
      if (run.status === 'success' && run.reachedAnswer && run.answer) {
        tested = true;
        return ok({ ok: true, answer: run.answer.slice(0, 1500), helpers_used: run.helpers, cost_usd: run.costUsd });
      }
      const hint =
        run.errorKind === 'credit'
          ? 'The agent ran out of credit. Tell the person; do not try to fix the workflow.'
          : run.errorKind === 'helper'
            ? 'A helper did not answer. Check the helper\'s input fields, or choose another helper.'
            : 'Read the workflow with get_workflow_details, fix it and test again.';
      return fail('The test did not produce an answer.', { kind: run.errorKind ?? 'other', hint, helpers_used: run.helpers });
    }
  }

  function progress(a: Record<string, unknown>): string {
    const step = a.step as BuildStep;
    if (!BUILD_STEPS.includes(step)) return fail('Unknown step.');
    if (step === 'ready' && !tested) return fail('Not ready yet: run test_agent and get a working answer first (a test counts only for the current version).');
    deps.emit({ type: 'progress', step });
    return ok({ shown: step });
  }

  function describe(err: unknown): string {
    if (err instanceof RelayRefusal) return fail(err.message, { problems: err.problems });
    if (err instanceof McpError) return fail(err.message.slice(0, 600));
    deps.log?.warn(`builder tool failed: ${(err as Error)?.message ?? String(err)}`);
    return fail('That step failed. Try once more, or tell the person plainly if it keeps failing.');
  }

  return {
    specs: TOOL_SPECS,
    async run(name, rawArgs) {
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = rawArgs ? JSON.parse(rawArgs) : {};
        if (!isObj(parsed)) return fail('The arguments must be a JSON object.');
        args = parsed;
      } catch {
        return fail('The arguments were not valid JSON.');
      }
      try {
        switch (name) {
          case 'find_helpers': {
            const query = str(args.query, 200);
            if (!query) return fail('Send a search in "query".');
            const cards = await deps.registry.search(query, 6);
            return ok(cards.length ? cards.map((c) => ({ id: c.entityId, name: c.name, what: c.what, price_usd: c.priceUsd })) : { results: [], note: 'No active agents matched. Try other words, or build without helpers.' });
          }
          case 'list_data_sources':
            return ok(deps.dataSources.map((s) => ({ name: s.name, what: s.what, max_price_usd: s.maxPriceUsd, fields: s.fields ?? null })));
          case 'update_preview':
            return await updatePreview(args);
          case 'get_template':
            return getTemplate(args);
          case 'test_agent':
            return await testAgent(args);
          case 'progress':
            return progress(args);
          default:
            if (!PASSTHROUGH.has(name)) return fail(`The tool "${name}" does not exist.`);
            {
              const result = await deps.relay.callForModel(name, args);
              // Any saved change makes an earlier test out of date.
              if (name === 'create_workflow_from_code' || name === 'update_workflow') tested = false;
              return ok(result);
            }
        }
      } catch (err) {
        return describe(err);
      }
    },
  };
}

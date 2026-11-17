// The tools the builder model can call (S2.3, S2.4, S2.6, S5.1). All of them are Studio's own: the model says what
// the agent is (find_helpers, list_data_sources, update_preview, build_agent, edit_agent) and Studio writes every
// n8n step itself through the guarded relay, so the model never writes workflow code or raw n8n operations.
// Every tool answers with a string and never throws, so one bad call cannot end the conversation. "Ready" is Studio's
// decision, not the model's: `progress("ready")` is refused until a test run has answered since the last change.
// When a test fails because a helper did not answer, Studio repairs the agent itself (switch the helper's input type,
// then leave the helper out) and tests again, within the test budget.
import type { DataSource } from '../env';
import type { ToolSpec } from '../openai';
import { McpError } from '../n8n/mcp';
import { N8nError } from '../n8n/rest';
import { RelayRefusal, type WorkflowRelay } from '../n8n/relay';
import { fromMicro, toMicro, toolKey, type RunView } from '../n8n/runs';
import type { HelperCard } from '../registry';
import type { Helper } from '../types';
import { copy } from '../copy';
import { formatUsd } from '../format';
import { BUILD_STEPS, type BuildEvent, type BuildStep, type Part, type PartState, type Preview } from './events';
import { NAME_LIMIT, SUMMARY_LIMIT } from './limits';
import type { AgentEdit, ToolInfo } from './edit';
import type { AgentSpec, RenderedTool } from './workflow-json';

export interface BuilderToolsDeps {
  listing: { id: string; name: string };
  /** Saves the agent's name and description on its listing, and its suggested price while it is still being built. */
  save(patch: { name: string; summary: string; priceUsd?: string }): Promise<unknown>;
  relay: Pick<WorkflowRelay, 'startRun' | 'readRun' | 'workflowId' | 'setup' | 'applyEdit' | 'saveAgent'>;
  registry: { search(query: string, limit?: number): Promise<HelperCard[]>; lookup(entityId: string): HelperCard | undefined };
  dataSources: DataSource[];
  zyndCredentialName: string;
  /** What is left in the agent's own wallet, USD, or null when unknown. Checked once before the first test. */
  balance?: () => Promise<string | null>;
  emit(event: BuildEvent): void;
  log?: Pick<Console, 'warn'>;
  /** How long a test run may take, and how often it is checked. */
  testTimeoutMs?: number;
  pollMs?: number;
  /** Most test runs per conversation turn, Studio's own repair runs included: each one can spend the agent's credit. */
  maxTests?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Where the agent stands after what has been called so far in this conversation turn. */
export interface ToolsState {
  /** The workflow was changed. */
  changed: boolean;
  /** A test run answered since the last change. */
  tested: boolean;
  /** `progress("ready")` was accepted. */
  ready: boolean;
  tests: number;
  /** Changes Studio made by itself after a failed test. */
  repairs: number;
  /** The agent could not be tested for lack of credit. */
  noCredit: boolean;
  /** Why the last test failed, if it did. */
  lastFailure?: string;
}

export interface BuilderTools {
  specs: ToolSpec[];
  run(name: string, rawArgs: string): Promise<string>;
  state(): ToolsState;
}

const OUTPUT_MAX = 14_000;
const DEFAULT_PRICE = '0.10';
const MAX_TOOLS = 5;
const MAX_REPAIRS = 2;
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

const helperArg = obj(
  {
    id: { type: 'string', description: 'An id returned by find_helpers.' },
    input: { type: 'string', enum: ['text', 'json'], description: 'Whether the helper takes plain text or a JSON object. Plain text unless its description asks for named fields.' },
    fields: { type: 'string', description: 'For json helpers: the field names it expects, comma separated.' },
  },
  ['id'],
);

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
    'build_agent',
    'Build (or rebuild) the whole agent from what it should do and the tools it uses. Studio writes and saves every part, with the right ids, credentials and payment limits. Run test_agent afterwards.',
    obj(
      {
        instructions: { type: 'string', description: 'What the agent does, what it needs in a request and how it should answer, written to the agent. Under 1500 characters.' },
        helpers: { type: 'array', items: helperArg, description: `At most ${MAX_TOOLS} helpers and data sources together.` },
        data_sources: { type: 'array', items: { type: 'string' }, description: 'Names returned by list_data_sources.' },
        web: { type: 'boolean', description: 'Let the agent read public web pages and open APIs that need no key.' },
      },
      ['instructions'],
    ),
  ),
  fn('get_agent_setup', 'What the agent does now (its instructions) and the tools it has: helpers, data sources and the web reader. Read this first when changing an agent that already exists.', obj({})),
  fn(
    'edit_agent',
    'Change an agent that already has a version: replace its instructions, add helpers or data sources, take tools away, switch the web reader on or off. All in one step; ids, credentials and payment limits are filled in for you. Run test_agent afterwards.',
    obj({
      instructions: { type: 'string', description: 'The complete new instructions (replaces the old ones, so keep what should stay). Under 1500 characters.' },
      add_helpers: { type: 'array', items: helperArg },
      add_data_sources: { type: 'array', items: { type: 'string' }, description: 'Names returned by list_data_sources.' },
      remove: { type: 'array', items: { type: 'string' }, description: 'Names of tools to take away, as get_agent_setup lists them.' },
      web: { type: 'boolean', description: 'true adds the web reader, false removes it.' },
    }),
  ),
  fn(
    'test_agent',
    'Run the agent once with a sample request and wait for its answer. May cost a few cents of the agent\'s credit. If a helper does not answer, Studio fixes the agent itself and tests again, and says what it changed. Needed before progress("ready").',
    obj({ question: { type: 'string' } }, ['question']),
  ),
  fn('progress', 'Tell the person which step you are on. "ready" is only accepted after a successful test_agent.', obj({ step: { type: 'string', enum: [...BUILD_STEPS] } }, ['step'])),
];

const NAMES = new Set(TOOL_SPECS.map((s) => s.name));

/** A tool as the picture of the agent needs it. */
interface ShownTool {
  name: string;
  kind: 'helper' | 'data source' | 'web';
  what?: string;
  maxPriceUsd?: string;
}
const quote = (text: string) => (text.length > 70 ? `${text.slice(0, 67).trimEnd()}…` : text);

/** The input type a helper gets: what its card allows, else what the model asked, else plain text. */
export function inputFor(card: HelperCard, asked: unknown): 'text' | 'json' {
  const modes = card.inputModes ?? [];
  const text = modes.includes('text/plain');
  const json = modes.includes('application/json');
  if (text && !json) return 'text';
  if (json && !text) return 'json';
  return asked === 'json' ? 'json' : 'text';
}

/** Whether a helper can be tried with the other input type. Unknown cards can. */
const canFlip = (card: HelperCard, to: 'text' | 'json') => !card.inputModes?.length || card.inputModes.includes(to === 'text' ? 'text/plain' : 'application/json');

export function createBuilderTools(deps: BuilderToolsDeps): BuilderTools {
  const st: ToolsState = { changed: false, tested: false, ready: false, tests: 0, repairs: 0, noCredit: false };
  /** The agent as last built in this turn, so Studio can repair it. Unknown for an agent built in an earlier turn. */
  let spec: AgentSpec | null = null;
  let built: RenderedTool[] | null = null;
  const flipped = new Set<string>();
  let checkedCredit = false;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // --- The picture of the agent and the activity lines (S5.3). Studio's own facts, never the model's account. ---
  let lines = 0;
  let shownTools: ShownTool[] = [];
  let brainDetail: string | undefined;
  const say = (label: string, state: 'running' | 'done' | 'failed' = 'running', id = `a${++lines}`): string => {
    deps.emit({ type: 'activity', activity: { id, label, state } });
    return id;
  };
  const toolPart = (t: ShownTool, state: PartState): Part => ({
    id: `tool:${t.name}`,
    kind: t.kind === 'data source' ? 'source' : t.kind,
    label: t.name,
    ...(t.what ? { detail: t.what.slice(0, 100) } : {}),
    ...(t.maxPriceUsd ? { priceUsd: t.maxPriceUsd } : {}),
    state,
  });
  /** Shows every part in `state`; `tool` may give a tool its own state (after a test). */
  const show = (state: PartState, tool?: (t: ShownTool) => Partial<Part>, main: PartState = state) => {
    const base = (id: Part['kind']): Part => ({ id, kind: id, state: main });
    deps.emit({
      type: 'blueprint',
      parts: [
        // A test runs through the in-app chat: the way in for other agents stays as it is.
        { ...base('network'), state: main === 'used' || main === 'testing' ? 'ready' : main },
        base('chat'),
        base('request'),
        { ...base('brain'), ...(brainDetail ? { detail: brainDetail } : {}) },
        ...shownTools.map((t) => ({ ...toolPart(t, state), ...tool?.(t) })),
        base('answer'),
      ],
    });
  };
  const fromSpec = (sp: AgentSpec): ShownTool[] => [
    ...sp.helpers.map((h) => ({ name: h.card.name, kind: 'helper' as const, what: h.card.what, maxPriceUsd: h.card.priceUsd })),
    ...sp.sources.map((x) => ({ name: x.name, kind: 'data source' as const, what: x.what, maxPriceUsd: x.maxPriceUsd })),
    ...(sp.web ? [{ name: 'Web page reader', kind: 'web' as const }] : []),
  ];

  const findSources = (names: unknown): DataSource[] | string => {
    const out: DataSource[] = [];
    for (const n of Array.isArray(names) ? names : []) {
      const s = deps.dataSources.find((d) => d.name === n);
      if (!s) return `Unknown data source "${String(n)}". Use a name from list_data_sources.`;
      if (!out.includes(s)) out.push(s);
    }
    return out;
  };
  const findHelpers = (ids: unknown): HelperCard[] | string => {
    const out: HelperCard[] = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const card = typeof id === 'string' ? deps.registry.lookup(id) : undefined;
      if (!card) return `"${String(id)}" is not a helper you found. Call find_helpers first and use the ids it returns.`;
      if (!out.includes(card)) out.push(card);
    }
    return out;
  };
  /** Helpers as the model listed them, with Studio's choice of input type. */
  const helperSpecs = (given: unknown): AgentSpec['helpers'] | string => {
    const list = (Array.isArray(given) ? given : []).filter(isObj);
    const cards = findHelpers(list.map((h) => h.id));
    if (typeof cards === 'string') return cards;
    return cards.map((card) => {
      const h = list.find((x) => x.id === card.entityId) as Record<string, unknown>;
      const input = inputFor(card, h.input);
      const fields = input === 'json' ? str(h.fields, 200) : '';
      return { card, input, ...(fields ? { fields } : {}) };
    });
  };
  const instructionsArg = (v: unknown): string => {
    const text = str(v, 1600);
    if (!text) throw new ToolProblem('Write the agent\'s instructions in "instructions".');
    if (text.length > 1500) throw new ToolProblem('The instructions are too long: 1500 characters at most.');
    return text;
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

    // An agent that is already built keeps the price its owner has: only the first build suggests one.
    await deps.save({ name, summary: description, ...(deps.relay.workflowId ? {} : { priceUsd: price }) });
    deps.listing.name = name;
    deps.emit({ type: 'preview', preview });
    brainDetail = description;
    const building = !deps.relay.workflowId;
    if (building) {
      shownTools = [...helpers.map((h) => ({ name: h.name, kind: 'helper' as const, what: h.what, maxPriceUsd: h.priceUsd })), ...sources.map((x) => ({ name: x.name, kind: 'data source' as const, what: x.what, maxPriceUsd: x.maxPriceUsd }))];
      show('planned');
    }
    say(building ? copy.build.planned(name) : copy.build.described(name), 'done');
    return ok({ shown: true, cost_per_use_usd: preview.costUsd });
  }

  const toolView = (t: ToolInfo) => ({ name: t.name, kind: t.kind, what: t.what, ...(t.maxPriceUsd ? { max_price_usd: t.maxPriceUsd } : {}) });

  /** Saves `next` as the agent. A change makes any earlier test out of date. */
  async function save(next: AgentSpec): Promise<{ created: boolean; problems: string[]; tools: RenderedTool[] }> {
    const out = await deps.relay.saveAgent(next);
    spec = next;
    built = out.tools;
    st.changed = true;
    st.tested = false;
    st.ready = false;
    return out;
  }

  async function buildAgent(a: Record<string, unknown>): Promise<string> {
    const instructions = instructionsArg(a.instructions);
    const helpers = helperSpecs(a.helpers);
    if (typeof helpers === 'string') return fail(helpers);
    const sources = findSources(a.data_sources);
    if (typeof sources === 'string') return fail(sources);
    if (helpers.length + sources.length > MAX_TOOLS) return fail(`Use at most ${MAX_TOOLS} helpers and data sources together: each one costs money every time it is used.`);
    const next: AgentSpec = { instructions, helpers, sources, web: a.web === true };
    const line = say(copy.build.saving);
    shownTools = fromSpec(next);
    show('building');
    let out: Awaited<ReturnType<typeof save>>;
    try {
      out = await save(next);
    } catch (err) {
      say(copy.build.savingFailed, 'failed', line);
      show('planned');
      throw err;
    }
    shownTools = out.tools;
    show('ready');
    say(copy.build.saved, 'done', line);
    return ok({
      saved: true,
      tools: out.tools.map((t) => ({ ...toolView(t), ...(t.input ? { input: t.input } : {}) })),
      ...(out.problems.length ? { problems: out.problems } : {}),
      next: 'Run test_agent with one realistic request.',
    });
  }

  async function agentSetup(): Promise<string> {
    if (!deps.relay.workflowId) return fail('This agent has no version yet: build it with build_agent first.');
    const line = say(copy.build.reading);
    const { instructions, tools } = await deps.relay.setup();
    shownTools = tools;
    show('ready');
    say(copy.build.reading, 'done', line);
    return ok({ instructions, tools: tools.map(toolView) });
  }

  async function editAgent(a: Record<string, unknown>): Promise<string> {
    if (!deps.relay.workflowId) return fail('This agent has no version yet. Build it with build_agent instead.');
    const edit: AgentEdit = {};
    if (a.instructions !== undefined) {
      const text = str(a.instructions, 1600);
      if (!text) return fail('"instructions" is empty. Send the complete new instructions, or leave it out to keep the old ones.');
      if (text.length > 1500) return fail('The instructions are too long: 1500 characters at most.');
      edit.instructions = text;
    }
    if (Array.isArray(a.add_helpers) && a.add_helpers.length) {
      const helpers = helperSpecs(a.add_helpers);
      if (typeof helpers === 'string') return fail(helpers);
      edit.addHelpers = helpers;
    }
    if (Array.isArray(a.add_data_sources) && a.add_data_sources.length) {
      const sources = findSources(a.add_data_sources);
      if (typeof sources === 'string') return fail(sources);
      edit.addSources = sources;
    }
    if (Array.isArray(a.remove) && a.remove.length) edit.remove = a.remove.filter((n): n is string => typeof n === 'string');
    if (typeof a.web === 'boolean') edit.web = a.web;

    const line = say(copy.build.changing);
    let applied: Awaited<ReturnType<typeof deps.relay.applyEdit>>;
    try {
      applied = await deps.relay.applyEdit(edit, deps.zyndCredentialName);
    } catch (err) {
      say(copy.build.changing, 'failed', line);
      throw err;
    }
    const { result, tools } = applied;
    shownTools = tools;
    show('ready');
    say(copy.build.changed, 'done', line);
    // An edit is not a whole spec: Studio cannot rebuild from it, so repairs are left to the model from here.
    spec = null;
    built = null;
    st.changed = true;
    st.tested = false;
    st.ready = false;
    return ok({ ...(isObj(result) ? result : {}), tools: tools.map(toolView), next: 'Run test_agent with a realistic request that uses the change.' });
  }

  /** Before spending a test: an agent whose wallet cannot pay even its cheapest tool is told so, not run. */
  async function creditProblem(): Promise<string | null> {
    if (checkedCredit || !deps.balance) return null;
    checkedCredit = true;
    const tools = built ?? (await deps.relay.setup()).tools;
    const prices = tools.map((t) => Number(t.maxPriceUsd ?? 0)).filter((p) => p > 0);
    if (prices.length === 0) return null;
    const balance = await deps.balance();
    if (balance === null || Number(balance) >= Math.min(...prices)) return null;
    st.noCredit = true;
    st.lastFailure = 'credit';
    say(copy.build.noCredit, 'failed');
    return fail('The agent has no credit for its helpers, so it was not tested.', {
      kind: 'credit',
      balance_usd: balance,
      hint: 'Tell the person the agent is built but needs credit before it can be tried. Do not change the agent.',
    });
  }

  /** One run, start to finish. A string is an error answer for the model. */
  async function runOnce(question: string): Promise<RunView | string> {
    st.tests += 1;
    deps.emit({ type: 'progress', step: 'testing' });
    const line = say(copy.build.trying(quote(question)));
    show('testing');
    const started = Date.now();
    const settled = (run: RunView | string): RunView | string => {
      if (typeof run === 'string') {
        say(copy.build.noAnswer, 'failed', line);
        show('ready');
        return run;
      }
      const byKey = new Map(run.helpers.map((h) => [toolKey(h.name), h]));
      for (const h of run.helpers) say(h.ok ? copy.build.helperUsed(h.name, formatUsd(h.costUsd)) : copy.build.helperSilent(h.name), h.ok ? 'done' : 'failed');
      const answered = run.status === 'success' && Boolean(run.answer);
      show(
        'ready',
        (t) => {
          const h = byKey.get(toolKey(t.name));
          return h ? { state: h.ok ? 'used' : 'failed', ...(h.ok ? { costUsd: h.costUsd } : {}) } : {};
        },
        answered ? 'used' : 'ready',
      );
      say(answered ? copy.build.answered(quote(question), String(Math.max(1, Math.round((Date.now() - started) / 1000)))) : copy.build.noAnswer, answered ? 'done' : 'failed', line);
      return run;
    };
    let id: string;
    try {
      id = await deps.relay.startRun(question, 'manual');
    } catch (err) {
      return settled(describe(err));
    }
    const deadline = Date.now() + (deps.testTimeoutMs ?? 240_000);
    for (;;) {
      await sleep(deps.pollMs ?? 2_000);
      let run: RunView;
      try {
        run = await deps.relay.readRun(id);
      } catch (err) {
        return settled(describe(err));
      }
      if (run.status !== 'running') return settled(run);
      if (Date.now() > deadline) {
        st.lastFailure = 'timeout';
        say(copy.build.noAnswer, 'failed', line);
        show('ready');
        return fail('The test took too long.', { kind: 'timeout', hint: 'Make the instructions simpler or use fewer helpers, then test again once.' });
      }
    }
  }

  /** The built tools a run says did not answer. */
  const notAnswering = (run: RunView): RenderedTool[] => {
    const bad = new Set(run.helpers.filter((h) => !h.ok).map((h) => toolKey(h.name)));
    return (built ?? []).filter((t) => t.kind !== 'web' && bad.has(toolKey(t.name)));
  };

  /**
   * Studio's own fix for tools that did not answer: another input type first, then (only when the agent gave no
   * answer at all) leaving them out.
   */
  function repairFor(failing: RenderedTool[], mayDrop: boolean): { next: AgentSpec; notes: string[]; lines: string[] } | null {
    if (!spec || failing.length === 0 || st.repairs >= MAX_REPAIRS) return null;
    const refs = new Set(failing.map((t) => t.ref));
    const flips = spec.helpers.filter((h) => refs.has(h.card.entityId) && !flipped.has(h.card.entityId) && canFlip(h.card, h.input === 'json' ? 'text' : 'json'));
    if (flips.length > 0) {
      const ids = new Set(flips.map((h) => h.card.entityId));
      ids.forEach((id) => flipped.add(id));
      return {
        next: { ...spec, helpers: spec.helpers.map((h) => (ids.has(h.card.entityId) ? { card: h.card, input: h.input === 'json' ? 'text' : 'json' } : h)) },
        notes: flips.map((h) => `${h.card.name} did not answer, so Studio now sends it ${h.input === 'json' ? 'plain text' : 'a JSON object'}.`),
        lines: flips.map((h) => copy.build.switched(h.card.name, h.input === 'json' ? copy.build.plainText : copy.build.namedFields)),
      };
    }
    if (!mayDrop) return null;
    const helpers = spec.helpers.filter((h) => !refs.has(h.card.entityId));
    const sources = spec.sources.filter((s) => !refs.has(`${s.listingUrl}|${s.operation}`));
    if (helpers.length === spec.helpers.length && sources.length === spec.sources.length) return null;
    return { next: { ...spec, helpers, sources }, notes: failing.map((t) => `${t.name} did not answer, so Studio left it out for now.`), lines: failing.map((t) => copy.build.leftOut(t.name)) };
  }

  async function testAgent(a: Record<string, unknown>): Promise<string> {
    const question = str(a.question, 1500);
    if (!question) return fail('Send a sample request in "question".');
    if (!deps.relay.workflowId) return fail('This agent has no version yet: build it with build_agent first.');
    const credit = await creditProblem();
    if (credit) return credit;

    const notes: string[] = [];
    const withNotes = (extra: Record<string, unknown>) => (notes.length ? { ...extra, studio_changed: notes, tell_the_person: 'Say in one sentence what Studio changed.' } : extra);
    for (;;) {
      if (st.tests >= (deps.maxTests ?? 4)) return fail('Enough test runs for now. Tell the person what happened so far.', withNotes({}));
      const run = await runOnce(question);
      if (typeof run === 'string') return run;
      const answered = run.status === 'success' && run.reachedAnswer && Boolean(run.answer);
      const failing = notAnswering(run);

      if (answered && failing.length === 0) {
        st.tested = true;
        st.lastFailure = undefined;
        return ok(withNotes({ ok: true, answer: (run.answer as string).slice(0, 1500), helpers_used: run.helpers, cost_usd: run.costUsd }));
      }
      if (run.errorKind === 'credit') {
        st.noCredit = true;
        st.lastFailure = 'credit';
        return fail('The agent ran out of credit during the test.', withNotes({ kind: 'credit', hint: 'Tell the person the agent needs credit before it can be tried. Do not change the agent.' }));
      }

      const repair = repairFor(failing, !answered);
      if (repair && st.tests < (deps.maxTests ?? 4)) {
        st.repairs += 1;
        const line = say(repair.lines.join('. '));
        shownTools = fromSpec(repair.next);
        show('building');
        try {
          const saved = await save(repair.next);
          shownTools = saved.tools;
        } catch (err) {
          say(repair.lines.join('. '), 'failed', line);
          return describe(err);
        }
        show('ready');
        say(repair.lines.join('. '), 'done', line);
        notes.push(...repair.notes);
        continue;
      }

      if (answered) {
        // It answered, but a helper never did: good enough to call it working, and the person should know.
        st.tested = true;
        st.lastFailure = undefined;
        return ok(withNotes({ ok: true, answer: (run.answer as string).slice(0, 1500), helpers_used: run.helpers, cost_usd: run.costUsd, not_answering: failing.map((t) => t.name), hint: 'Tell the person which helper did not answer in the test.' }));
      }
      st.lastFailure = run.errorKind ?? 'other';
      const hint =
        run.errorKind === 'helper'
          ? 'A helper did not answer. Choose another helper with build_agent, or build without it.'
          : 'Make the instructions clearer with build_agent (or edit_agent for an existing agent) and test again.';
      return fail('The test did not produce an answer.', withNotes({ kind: run.errorKind ?? 'other', hint, helpers_used: run.helpers }));
    }
  }

  function progress(a: Record<string, unknown>): string {
    const step = a.step as BuildStep;
    if (!BUILD_STEPS.includes(step)) return fail('Unknown step.');
    if (step === 'ready' && !st.tested) return fail('Not ready yet: run test_agent and get a working answer first (a test counts only for the current version).');
    if (step === 'ready') {
      st.ready = true;
      say(copy.build.ready, 'done');
    }
    deps.emit({ type: 'progress', step });
    return ok({ shown: step });
  }

  function describe(err: unknown): string {
    if (err instanceof ToolProblem) return fail(err.message);
    if (err instanceof RelayRefusal) return fail(err.message, { problems: err.problems });
    if (err instanceof McpError || err instanceof N8nError) return fail(`Studio could not reach the agent service: ${err.message.slice(0, 300)}. Try once more.`);
    deps.log?.warn(`builder tool failed: ${(err as Error)?.message ?? String(err)}`);
    return fail('That step failed. Try once more, or tell the person plainly if it keeps failing.');
  }

  return {
    specs: TOOL_SPECS,
    state: () => ({ ...st }),
    async run(name, rawArgs) {
      if (!NAMES.has(name)) return fail(`The tool "${name}" does not exist.`);
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
            const line = say(copy.build.searching(quote(query)));
            let cards: HelperCard[];
            try {
              cards = await deps.registry.search(query, 6);
            } catch (err) {
              say(copy.build.foundNone, 'failed', line);
              throw err;
            }
            say(cards.length ? copy.build.found(String(cards.length)) : copy.build.foundNone, 'done', line);
            return ok(cards.length ? cards.map((c) => ({ id: c.entityId, name: c.name, what: c.what, price_usd: c.priceUsd })) : { results: [], note: 'No active agents matched. Try other words, or build without helpers.' });
          }
          case 'list_data_sources':
            say(copy.build.sources(String(deps.dataSources.length)), 'done');
            return ok(deps.dataSources.map((s) => ({ name: s.name, what: s.what, max_price_usd: s.maxPriceUsd, fields: s.fields ?? null })));
          case 'update_preview':
            return await updatePreview(args);
          case 'build_agent':
            return await buildAgent(args);
          case 'get_agent_setup':
            return await agentSetup();
          case 'edit_agent':
            return await editAgent(args);
          case 'test_agent':
            return await testAgent(args);
          default:
            return progress(args);
        }
      } catch (err) {
        return describe(err);
      }
    },
  };
}

/** A plain refusal of a tool's arguments. */
class ToolProblem extends Error {}

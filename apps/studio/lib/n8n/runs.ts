// Reading one execution back from n8n. The raw execution data holds the prompt, response headers, the OpenAI
// organisation id and a resume token, so nothing here ever returns it: only the answer, the helpers used (with what
// each cost) and a plain error class are picked out (S0.5 b).
import { NODE } from '../builder/template';

export type RunStatus = 'running' | 'success' | 'error' | 'canceled';

/** How a failed run reads to a person (S4.2 turns each into plain words). */
export type RunErrorKind = 'credit' | 'helper' | 'timeout' | 'other';

export interface UsedHelper {
  /** The tool's name as the AI saw it, made readable. */
  name: string;
  /** What this call cost, a decimal string. */
  costUsd: string;
  /** False when the helper did not answer. */
  ok: boolean;
}

export interface RunView {
  status: RunStatus;
  answer?: string;
  helpers: UsedHelper[];
  /** Total paid to helpers and data sources in this run. */
  costUsd: string;
  errorKind?: RunErrorKind;
  /** The workflow reported it ran through the Answer step. */
  reachedAnswer: boolean;
  startedAt?: string;
}

const MICRO = 1_000_000n;

/** "0.050000" -> 50000n. Anything that is not a plain decimal is 0. */
export function toMicro(v: unknown): bigint {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  const m = /^(\d{1,9})(?:\.(\d{1,6})\d*)?$/.exec(s);
  if (!m) return 0n;
  return BigInt(m[1] as string) * MICRO + BigInt((m[2] ?? '').padEnd(6, '0'));
}

export function fromMicro(n: bigint): string {
  const whole = n / MICRO;
  const frac = (n % MICRO).toString().padStart(6, '0');
  return `${whole}.${frac}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A readable name from an AI tool name: `Counterparty_Check` -> `Counterparty Check`. */
export const toolLabel = (tool: string) => tool.replace(/_+/g, ' ').trim() || 'Helper';

/** The observation of a tool call is a JSON string (`[{…}]`). Returns the first item, or null. */
function observationItem(observation: unknown): Record<string, unknown> | null {
  let v: unknown = observation;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  const item = Array.isArray(v) ? v[0] : v;
  return isObj(item) ? item : null;
}

/** n8n turns a tool's node name into the AI's tool name (`Counterparty Check` -> `Counterparty_Check`). */
export const toolKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * What one intermediate step paid, or null when it was not a paid call (the web reader, Think, Calculator).
 * `paidTools` holds the tool keys of the agent's helper and data-source steps: one of those that handed the AI an
 * error text instead of a result counts as a helper that did not answer.
 */
function paidCall(step: unknown, paidTools: ReadonlySet<string>): UsedHelper | null {
  if (!isObj(step) || !isObj(step.action)) return null;
  const item = observationItem(step.observation);
  const tool = String(step.action.tool ?? '');
  const name = toolLabel(tool);
  if (!item) return paidTools.has(toolKey(tool)) ? { name, costUsd: '0.000000', ok: false } : null;
  if (typeof item.paymentUsd === 'string' || typeof item.paymentUsd === 'number') {
    const failed = item.status === 'FAILED' || item.status === 'TIMEOUT' || item.status === 'CANCELED' || Boolean(item.error);
    return { name, costUsd: fromMicro(toMicro(item.paymentUsd)), ok: !failed };
  }
  if (typeof item.taskId === 'string') return { name, costUsd: '0.000000', ok: item.status === 'COMPLETED' };
  if (isObj(item.payment) && item.payment.amountUsd !== undefined) return { name, costUsd: fromMicro(toMicro(item.payment.amountUsd)), ok: true };
  if (isObj(item.attestation) || typeof item.listingUrl === 'string') return { name, costUsd: '0.000000', ok: true };
  return null;
}

/** Sorts a failure message into the few cases the UI has plain words for. */
export function classifyRunError(message: string | undefined): RunErrorKind {
  const m = (message ?? '').toLowerCase();
  if (/payment|insufficient|balance|spend cap|402/.test(m)) return 'credit';
  if (/timed? ?out|timeout|took too long/.test(m)) return 'timeout';
  if (/agent task|helper|zynd|404|not found|502|gateway/.test(m)) return 'helper';
  return 'other';
}

/** The latest run of a node: `runData[name]` is a list of runs, the last one is the one that matters. */
function lastRunJson(runData: Record<string, unknown>, node: string): Record<string, unknown> | null {
  const runs = runData[node];
  if (!Array.isArray(runs) || runs.length === 0) return null;
  const run = runs[runs.length - 1];
  const main = isObj(run) && isObj(run.data) ? run.data.main : undefined;
  const first = Array.isArray(main) && Array.isArray(main[0]) ? main[0][0] : undefined;
  return isObj(first) && isObj(first.json) ? first.json : null;
}

/**
 * The reply of `get_workflow_execution` (with `includeData` and `nodeNames`) as a view the UI may show.
 * Anything unexpected becomes a failed or still-running view, never an exception.
 */
export function parseExecution(raw: unknown, paidTools: ReadonlySet<string> = new Set()): RunView {
  const view: RunView = { status: 'running', helpers: [], costUsd: '0.000000', reachedAnswer: false };
  if (!isObj(raw)) return { ...view, status: 'error', errorKind: 'other' };
  const ex = isObj(raw.execution) ? raw.execution : {};
  const status = String(ex.status ?? '');
  view.status =
    status === 'success' ? 'success' : status === 'canceled' ? 'canceled' : status === 'error' || status === 'crashed' ? 'error' : 'running';
  if (typeof ex.startedAt === 'string') view.startedAt = ex.startedAt;
  if (view.status === 'running') return view;

  const result = isObj(raw.data) && isObj(raw.data.resultData) ? raw.data.resultData : {};
  const runData = isObj(result.runData) ? result.runData : {};

  const ai = lastRunJson(runData, NODE.ai);
  if (ai && Array.isArray(ai.intermediateSteps)) {
    let total = 0n;
    for (const step of ai.intermediateSteps) {
      const call = paidCall(step, paidTools);
      if (!call) continue;
      view.helpers.push(call);
      total += toMicro(call.costUsd);
    }
    view.costUsd = fromMicro(total);
  }

  const answer = lastRunJson(runData, NODE.answer);
  if (answer && typeof answer.output === 'string' && answer.output.trim()) {
    view.answer = answer.output.trim();
    view.reachedAnswer = true;
  } else if (ai && typeof ai.output === 'string' && ai.output.trim()) {
    view.answer = ai.output.trim();
  }

  if (view.status === 'error' || !view.answer) {
    const message = isObj(result.error) && typeof result.error.message === 'string' ? result.error.message : undefined;
    view.errorKind = classifyRunError(message);
    if (view.status === 'success') view.status = 'error';
  }
  return view;
}

/** The question a run was started with, read from the Request step. */
export function parseRequest(raw: unknown): string | undefined {
  if (!isObj(raw) || !isObj(raw.data) || !isObj(raw.data.resultData)) return undefined;
  const runData = isObj(raw.data.resultData.runData) ? raw.data.resultData.runData : {};
  const req = lastRunJson(runData, NODE.request);
  return req && typeof req.request === 'string' ? req.request : undefined;
}

// S6: reading what an agent has done so far in a run, while it is still going. n8n keeps every step of a run as it
// finishes when the workflow saves its progress (the setting Studio writes into every agent). A tool use that has
// started but not finished is there too, as a placeholder step with the arguments but no status, so a search or a
// hire can be shown as it begins and again as it ends. Verified against the real n8n on 2026-11-17.
//
// Only the few facts the picture needs leave this file: which step, what was asked, who answered, what it cost.
import { isFindStep, isHireStep } from '../builder/network';
import type { CallKind, FoundAgent, NetCall } from '../network';
import { fromMicro, toMicro } from './runs';
import type { N8nNode } from './policy';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const plain = (v: unknown, max: number): string =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const ENTITY = /^zns:[A-Za-z0-9_-]{8,80}$/;

/** What kind of step this is, or null when it is not one the picture shows. */
export function callKind(n: N8nNode): CallKind | null {
  if (n.disabled) return null;
  if (isFindStep(n)) return 'search';
  if (isHireStep(n)) return 'hire';
  if (n.type === 'CUSTOM.zyndTool') return 'helper';
  if (n.type === 'CUSTOM.zyndAirnodeTool') return 'source';
  if (n.type === 'n8n-nodes-base.httpRequestTool') return 'web';
  return null;
}

/** The arguments the AI gave one use of a tool. */
function argsOf(run: Record<string, unknown>): Record<string, unknown> {
  const input = isObj(run.inputOverride) ? run.inputOverride.ai_tool : undefined;
  const first = Array.isArray(input) && Array.isArray(input[0]) ? input[0][0] : undefined;
  return isObj(first) && isObj(first.json) ? first.json : {};
}

/** What one use of a tool gave back: the items of its output, each as the object n8n holds. */
function itemsOf(run: Record<string, unknown>): Record<string, unknown>[] {
  const data = isObj(run.data) ? run.data.ai_tool : undefined;
  const items = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
  return items.map((i) => (isObj(i) && isObj(i.json) ? i.json : {}));
}

/** The agent a search result is. The results are untrusted text from other agents: names are cut and cleaned. */
function foundFrom(item: Record<string, unknown>): FoundAgent | null {
  const id = item.entity_id ?? item.entityId;
  if (typeof id !== 'string' || !ENTITY.test(id)) return null;
  return { entityId: id, name: plain(item.name, 60) || `Agent ${id.slice(4, 10)}`, what: plain(item.summary ?? item.description, 140), ...(typeof item.url === 'string' ? { url: item.url } : {}) };
}

/** The price one finished use paid, from what the Gateway or the data source sent back. */
function paidFrom(items: Record<string, unknown>[]): string | undefined {
  for (const item of items) {
    if (typeof item.paymentUsd === 'string' || typeof item.paymentUsd === 'number') return fromMicro(toMicro(item.paymentUsd));
    if (isObj(item.payment) && item.payment.amountUsd !== undefined) return fromMicro(toMicro(item.payment.amountUsd));
  }
  return undefined;
}

const fixedAgentId = (n: N8nNode): string | undefined => (typeof n.parameters?.agentId === 'string' && ENTITY.test(n.parameters.agentId) ? n.parameters.agentId : undefined);

/**
 * Every use of the agent's steps in a run, oldest first. `runData` is the run's per-step record (finished or still
 * going); `nodes` are the agent's steps, which say what each one is. A use without a status is still going.
 */
export function parseCalls(runData: unknown, nodes: readonly N8nNode[]): NetCall[] {
  if (!isObj(runData)) return [];
  const rows: { at: number; order: number; call: NetCall }[] = [];
  let order = 0;
  for (const n of nodes) {
    const kind = callKind(n);
    const runs = runData[n.name];
    if (!kind || !Array.isArray(runs)) continue;
    runs.forEach((raw, index) => {
      if (!isObj(raw)) return;
      const status = typeof raw.executionStatus === 'string' ? raw.executionStatus : undefined;
      const state = status === undefined ? 'calling' : status === 'success' ? 'done' : 'failed';
      const args = argsOf(raw);
      const items = state === 'done' ? itemsOf(raw) : [];
      const call: NetCall = { id: `${n.name}#${index}`, kind, tool: n.name, state };

      if (kind === 'search') {
        const query = plain(args.query, 120);
        if (query) call.query = query;
        const found = items.map(foundFrom).filter((f): f is FoundAgent => f !== null).slice(0, 10);
        if (state === 'done') call.found = found;
      } else if (kind === 'hire') {
        const id = typeof args.agentId === 'string' ? args.agentId.trim() : '';
        if (ENTITY.test(id)) call.agentId = id;
      } else if (kind === 'helper') {
        const id = fixedAgentId(n);
        if (id) call.agentId = id;
        const price = n.parameters?.maxPaymentUsd;
        if (typeof price === 'string') call.priceUsd = price;
      } else if (kind === 'source') {
        const price = n.parameters?.maxPaymentUsd;
        if (typeof price === 'string') call.priceUsd = price;
      }
      if (state === 'done' && kind !== 'search' && kind !== 'web') {
        const paid = paidFrom(items);
        if (paid !== undefined) call.paidUsd = paid;
      }
      const startedAt = typeof raw.startTime === 'number' && raw.startTime > 0 ? raw.startTime : Number.MAX_SAFE_INTEGER;
      rows.push({ at: startedAt, order: order++, call });
    });
  }
  rows.sort((a, b) => a.at - b.at || a.order - b.order);
  return rows.map((r) => r.call);
}

/**
 * A run as n8n's REST API reports it, in the shape the rest of Studio reads (`parseExecution`, `parseRequest`):
 * the status and start time, and the per-step data. Nothing else leaves.
 */
export function normaliseRestExecution(raw: unknown): { execution: { status: string; startedAt?: string; workflowId?: string }; data: unknown; nodes: N8nNode[] } {
  const ex = isObj(raw) ? raw : {};
  const wfData = isObj(ex.workflowData) ? ex.workflowData : {};
  return {
    execution: {
      status: typeof ex.status === 'string' ? ex.status : ex.finished === true ? 'success' : 'running',
      ...(typeof ex.startedAt === 'string' ? { startedAt: ex.startedAt } : {}),
      ...(ex.workflowId !== undefined && ex.workflowId !== null ? { workflowId: String(ex.workflowId) } : {}),
    },
    data: ex.data,
    nodes: Array.isArray(wfData.nodes) ? (wfData.nodes as N8nNode[]) : [],
  };
}

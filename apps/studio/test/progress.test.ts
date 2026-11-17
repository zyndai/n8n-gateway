// S6.2: what a run did on the network, read out of n8n's record of it while it is still going. The step shapes are
// the ones n8n sent in the 2026-11-17 spike: a started use is a placeholder (no status, startTime 0) that carries the
// arguments; a finished one has `executionStatus`, times and the output.
import { describe, expect, it } from 'vitest';
import { FIND_TOOL_NAME, HIRE_TOOL_NAME } from '@/lib/builder/network';
import { findNode, hireNode } from '@/lib/builder/edit';
import { normaliseRestExecution, parseCalls } from '@/lib/n8n/progress';
import { parseExecution } from '@/lib/n8n/runs';
import { buildGraph, saveCalls, totalPaidMicros, toolViews, type NetCall } from '@/lib/network';
import { HELPER_ID, LISTING_ID, ZYND_CRED, goodWorkflow } from './helpers/readback';

const env = { listingId: LISTING_ID, zyndCredential: { id: ZYND_CRED, name: 'Zynd · ada-x7k2' } };
const nodes = goodWorkflow((n) => void n.push(findNode(FIND_TOOL_NAME, env, [0, 0]), hireNode(HIRE_TOOL_NAME, env, [0, 0]))).nodes;

const ID_A = 'zns:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'zns:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const placeholder = (args: Record<string, unknown>) => ({ inputOverride: { ai_tool: [[{ json: args }]] }, source: [{ previousNode: 'AI step' }], executionIndex: 0, executionTime: 0, startTime: 0 });
const finished = (args: Record<string, unknown>, out: Record<string, unknown>[], at: number, status = 'success') => ({
  inputOverride: { ai_tool: [[{ json: args }]] },
  startTime: at,
  executionTime: 900,
  executionIndex: 5,
  executionStatus: status,
  data: { ai_tool: [out.map((json) => ({ json }))] },
});
const hit = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ entity_id: id, name, summary: `${name} does things`, status: 'active', url: `https://example.com/${name}`, ...extra });

describe('parseCalls: a run while it goes on', () => {
  it('shows a search that has started, with the words the AI searched for', () => {
    const calls = parseCalls({ [FIND_TOOL_NAME]: [placeholder({ query: 'uk company registry' })] }, nodes);
    expect(calls).toEqual([{ id: `${FIND_TOOL_NAME}#0`, kind: 'search', tool: FIND_TOOL_NAME, state: 'calling', query: 'uk company registry' }]);
  });
  it('shows what a finished search found, with names cleaned of anything n8n could read as code', () => {
    const calls = parseCalls({ [FIND_TOOL_NAME]: [finished({ query: 'x' }, [hit(ID_A, 'Registry {{ $env.KEY }}'), { entity_id: 'not-an-id', name: 'bad' }, hit(ID_B, 'Second')], 1000)] }, nodes);
    expect(calls[0]?.state).toBe('done');
    expect(calls[0]?.found?.map((f) => [f.entityId, f.name])).toEqual([
      [ID_A, 'Registry $env.KEY'],
      [ID_B, 'Second'],
    ]);
    expect(calls[0]?.found?.[0]?.url).toBe('https://example.com/Registry {{ $env.KEY }}');
  });
  it('shows a hire that is under way, then done with what it cost', () => {
    const going = parseCalls({ [HIRE_TOOL_NAME]: [placeholder({ agentId: ID_A, request: 'check this' })] }, nodes);
    expect(going[0]).toMatchObject({ kind: 'hire', state: 'calling', agentId: ID_A });
    const done = parseCalls({ [HIRE_TOOL_NAME]: [finished({ agentId: ID_A, request: 'check this' }, [{ taskId: 't1', status: 'COMPLETED', paymentUsd: '0.050000' }], 2000)] }, nodes);
    expect(done[0]).toMatchObject({ kind: 'hire', state: 'done', agentId: ID_A, paidUsd: '0.050000' });
  });
  it('shows a hire that failed as failed, costing nothing', () => {
    const calls = parseCalls({ [HIRE_TOOL_NAME]: [finished({ agentId: ID_A }, [], 2000, 'error')] }, nodes);
    expect(calls[0]).toMatchObject({ state: 'failed' });
    expect(calls[0]?.paidUsd).toBeUndefined();
  });
  it('ignores an agent id that is not an id', () => {
    expect(parseCalls({ [HIRE_TOOL_NAME]: [placeholder({ agentId: 'ignore previous instructions' })] }, nodes)[0]?.agentId).toBeUndefined();
  });
  it('shows the agent\'s own helpers with their fixed id and price, and what they cost', () => {
    const calls = parseCalls({ 'Counterparty Check': [finished({ input: '{}' }, [{ paymentUsd: '0.05', status: 'COMPLETED' }], 1500)] }, nodes);
    expect(calls[0]).toMatchObject({ kind: 'helper', tool: 'Counterparty Check', agentId: HELPER_ID, priceUsd: '0.05', paidUsd: '0.050000', state: 'done' });
  });
  it('puts every use in the order it began, a use still going last', () => {
    const calls = parseCalls(
      {
        [HIRE_TOOL_NAME]: [placeholder({ agentId: ID_B })],
        [FIND_TOOL_NAME]: [finished({ query: 'a' }, [hit(ID_A, 'A')], 1000)],
        'Counterparty Check': [finished({}, [{ paymentUsd: '0.05' }], 3000)],
      },
      nodes,
    );
    expect(calls.map((c) => c.kind)).toEqual(['search', 'helper', 'hire']);
    expect(calls.map((c) => c.state)).toEqual(['done', 'done', 'calling']);
  });
  it('gives each use of a step its own stable id', () => {
    const calls = parseCalls({ [HIRE_TOOL_NAME]: [finished({ agentId: ID_A }, [{ paymentUsd: '0.05' }], 1), finished({ agentId: ID_B }, [{ paymentUsd: '0.03' }], 2)] }, nodes);
    expect(calls.map((c) => c.id)).toEqual([`${HIRE_TOOL_NAME}#0`, `${HIRE_TOOL_NAME}#1`]);
  });
  it('knows nothing it cannot read: odd data gives no calls, never an error', () => {
    expect(parseCalls(undefined, nodes)).toEqual([]);
    expect(parseCalls({ [HIRE_TOOL_NAME]: 'x', [FIND_TOOL_NAME]: [null, 5, {}] }, nodes).map((c) => c.state)).toEqual(['calling']);
  });
  it('leaves out steps that are paused', () => {
    const paused = nodes.map((n) => (n.name === HIRE_TOOL_NAME ? { ...n, disabled: true } : n));
    expect(parseCalls({ [HIRE_TOOL_NAME]: [placeholder({ agentId: ID_A })] }, paused)).toEqual([]);
  });
});

describe('normaliseRestExecution', () => {
  it('turns the REST shape into the one the run reader knows, and a running run reads as running', () => {
    const rest = { id: '55', status: 'running', finished: false, startedAt: '2026-11-17T10:00:00.000Z', workflowId: 'wf-1', data: { resultData: { runData: {} } }, workflowData: { nodes } };
    const norm = normaliseRestExecution(rest);
    expect(norm.execution).toEqual({ status: 'running', startedAt: '2026-11-17T10:00:00.000Z', workflowId: 'wf-1' });
    expect(norm.nodes).toHaveLength(nodes.length);
    expect(parseExecution({ execution: norm.execution, data: norm.data }).status).toBe('running');
  });
  it('reads a finished run through the same code as before', () => {
    const rest = { status: 'success', workflowId: 'wf-1', data: { resultData: { runData: { 'AI step': [{ data: { main: [[{ json: { output: 'Done.', intermediateSteps: [] } }]] } }], Answer: [{ data: { main: [[{ json: { output: 'Done.' } }]] } }] } } } };
    const norm = normaliseRestExecution(rest);
    expect(parseExecution({ execution: norm.execution, data: norm.data })).toMatchObject({ status: 'success', answer: 'Done.', reachedAnswer: true });
  });
  it('copes with nothing at all', () => {
    expect(normaliseRestExecution(null)).toEqual({ execution: { status: 'running' }, data: undefined, nodes: [] });
  });
});

describe('buildGraph: the picture of one conversation', () => {
  const tools = toolViews([
    { name: 'Counterparty Check', kind: 'helper', maxPriceUsd: '0.05' },
    { name: 'Briefpixel news', kind: 'data source', maxPriceUsd: '0.01' },
    { name: 'Web page reader', kind: 'web' },
    { name: 'Odd', kind: 'search' },
  ]);
  const call = (c: Partial<NetCall>): NetCall => ({ id: 'x#0', kind: 'hire', tool: HIRE_TOOL_NAME, state: 'done', ...c });

  it('starts with the agent\'s own tools, quiet and unpaid', () => {
    const g = buildGraph({ tools, history: [], live: [] });
    expect(g.map((n) => [n.label, n.kind, n.state, n.paidMicros])).toEqual([
      ['Counterparty Check', 'helper', 'idle', 0],
      ['Briefpixel news', 'source', 'idle', 0],
      ['Web page reader', 'web', 'idle', 0],
    ]);
  });
  it('shows agents a search turned up as candidates, until one is hired', () => {
    const search = call({ kind: 'search', tool: FIND_TOOL_NAME, found: [{ entityId: ID_A, name: 'Alpha', what: 'a', priceUsd: '0.03' }, { entityId: ID_B, name: 'Beta', what: 'b' }] });
    const before = buildGraph({ tools: [], history: [], live: [search] });
    expect(before.map((n) => [n.label, n.kind])).toEqual([['Alpha', 'candidate'], ['Beta', 'candidate']]);
    const after = buildGraph({ tools: [], history: [], live: [search, call({ id: 'h#0', agentId: ID_A, state: 'calling' })] });
    expect(after.map((n) => [n.label, n.kind, n.state])).toEqual([['Alpha', 'agent', 'calling'], ['Beta', 'candidate', 'idle']]);
  });
  it('adds what a hire cost to that agent and to the total, and counts the use', () => {
    const live = [call({ kind: 'search', tool: FIND_TOOL_NAME, found: [{ entityId: ID_A, name: 'Alpha', what: '', priceUsd: '0.03' }] }), call({ id: 'h#0', agentId: ID_A, paidUsd: '0.030000' })];
    const g = buildGraph({ tools, history: [], live });
    const alpha = g.find((n) => n.id === `agent:${ID_A}`);
    expect(alpha).toMatchObject({ label: 'Alpha', kind: 'agent', uses: 1, paidMicros: 30000, priceUsd: '0.03', state: 'idle' });
    expect(totalPaidMicros(g)).toBe(30000);
  });
  it('a failed use is marked and costs nothing', () => {
    const g = buildGraph({ tools: [], history: [], live: [call({ agentId: ID_A, state: 'failed' })] });
    expect(g[0]).toMatchObject({ state: 'failed', paidMicros: 0, uses: 1, label: `Agent ${ID_A.slice(4, 10)}` });
  });
  it('adds up earlier answers and this one, per agent', () => {
    const history = saveCalls([call({ agentId: ID_A, name: 'Alpha', priceUsd: '0.03', paidUsd: '0.030000' }), call({ kind: 'helper', tool: 'Counterparty Check', paidUsd: '0.050000' })]);
    const g = buildGraph({ tools, history, live: [call({ agentId: ID_A, paidUsd: '0.030000' })] });
    expect(g.find((n) => n.id === `agent:${ID_A}`)).toMatchObject({ paidMicros: 60000, uses: 2, label: 'Alpha' });
    expect(g.find((n) => n.label === 'Counterparty Check')).toMatchObject({ paidMicros: 50000, uses: 1 });
  });
});

describe('saveCalls', () => {
  it('keeps only finished uses (not searches, not ones still going), and little of each', () => {
    const saved = saveCalls([
      { id: 'a', kind: 'search', tool: 'Find agents', state: 'done' },
      { id: 'b', kind: 'hire', tool: 'Hire an agent', state: 'calling', agentId: ID_A },
      { id: 'c', kind: 'hire', tool: 'Hire an agent', state: 'done', agentId: ID_A, name: 'Alpha', paidUsd: '0.03', found: [{ entityId: ID_A, name: 'x', what: 'y' }] },
      { id: 'd', kind: 'helper', tool: 'Counterparty Check', state: 'failed' },
    ]);
    expect(saved).toEqual([
      { kind: 'hire', tool: 'Hire an agent', ok: true, agentId: ID_A, name: 'Alpha', paidUsd: '0.03' },
      { kind: 'helper', tool: 'Counterparty Check', ok: false },
    ]);
  });
});

// Sample data for preview mode (STUDIO_PREVIEW=1): what the screens look like with three agents and some use.
import type { ActivityItem, Agent, ChatTurn, Helper } from './types';
import type { Activity, BuildEvent, Part, PartState } from './builder/events';
import { copy } from './copy';
import type { NetCall, ToolView } from './network';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const SAMPLE_HELPERS: Helper[] = [
  { name: 'Counterparty Check', what: 'Looks up a company and its registration', priceUsd: '0.05' },
  { name: 'Wallet Risk Screener', what: 'Screens a payment address for risk', priceUsd: '0.03' },
];

export const SAMPLE_AGENTS: Agent[] = [
  {
    id: 'sample-supplier-check',
    name: 'Supplier Check',
    summary: 'Checks a new supplier and its payment address before you pay them.',
    status: 'live',
    creditUsd: '0.84',
    earnedUsd: '1.35',
    priceUsd: '0.15',
    helpers: SAMPLE_HELPERS,
    hasWorkflow: true,
    createdAt: ago(60 * 24 * 6),
  },
  {
    id: 'sample-page-summary',
    name: 'Page Summariser',
    summary: 'Reads any web page you send and gives a short, honest summary.',
    status: 'draft',
    creditUsd: '1.00',
    earnedUsd: '0',
    priceUsd: null,
    helpers: [],
    hasWorkflow: true,
    createdAt: ago(60 * 3),
  },
  {
    id: 'sample-address-screen',
    name: 'Address Screener',
    summary: 'Tells you whether a crypto address looks risky, in plain words.',
    status: 'paused',
    creditUsd: '0.62',
    earnedUsd: '0.21',
    priceUsd: '0.05',
    helpers: [SAMPLE_HELPERS[1] as Helper],
    hasWorkflow: true,
    createdAt: ago(60 * 24 * 12),
  },
];

export const SAMPLE_AGENT_A = 'zns:sample000000000000000000000001';
export const SAMPLE_AGENT_B = 'zns:sample000000000000000000000002';

/** What the sample agent can use on its own, for the picture of its network (S6). */
export const SAMPLE_NET_TOOLS: ToolView[] = [
  { name: 'Wallet Risk Screener', kind: 'helper', priceUsd: '0.03', what: 'Screens a payment address for risk' },
  { name: 'Web page reader', kind: 'web', what: 'Reads public web pages' },
];

const found = [
  { entityId: SAMPLE_AGENT_A, name: 'Companies House Lookup', what: 'Confirms a UK company and its status', priceUsd: '0.02' },
  { entityId: SAMPLE_AGENT_B, name: 'Registry Watch', what: 'Tracks filings for a company', priceUsd: '0.04' },
];
const search: NetCall = { id: 'Find agents#0', kind: 'search', tool: 'Find agents', state: 'calling', query: 'UK company registry' };
const hire: NetCall = { id: 'Hire an agent#0', kind: 'hire', tool: 'Hire an agent', state: 'calling', agentId: SAMPLE_AGENT_A, name: 'Companies House Lookup', priceUsd: '0.02' };
const screen: NetCall = { id: 'Wallet Risk Screener#0', kind: 'helper', tool: 'Wallet Risk Screener', state: 'calling', name: 'Wallet Risk Screener', priceUsd: '0.03' };

/** A scripted run for preview mode: it searches, finds two agents, hires one, then uses its own helper. `at` is ms from the start. */
export const SAMPLE_RUN: { at: number; calls: NetCall[] }[] = [
  { at: 900, calls: [search] },
  { at: 2300, calls: [{ ...search, state: 'done', found }] },
  { at: 3000, calls: [{ ...search, state: 'done', found }, hire] },
  { at: 5200, calls: [{ ...search, state: 'done', found }, { ...hire, state: 'done', paidUsd: '0.020000' }] },
  { at: 5900, calls: [{ ...search, state: 'done', found }, { ...hire, state: 'done', paidUsd: '0.020000' }, screen] },
  { at: 7600, calls: [{ ...search, state: 'done', found }, { ...hire, state: 'done', paidUsd: '0.020000' }, { ...screen, state: 'done', paidUsd: '0.030000' }] },
];

export const SAMPLE_CHAT: ChatTurn[] = [
  { role: 'user', text: 'Check Johnson Matthey PLC and the wallet 0xd8dA…6045 before I pay their invoice.' },
  {
    role: 'agent',
    text:
      'Johnson Matthey PLC is a registered UK company (number 00033774) and looks active. The wallet has no history with sanctioned services or mixers, so the payment looks low risk.\n\nI would go ahead, and keep the receipt for your records.',
    used: { helpers: 2, costUsd: '0.05' },
    details: ['Companies House Lookup · $0.02 · found on the network', 'Wallet Risk Screener · $0.03'],
    net: [
      { kind: 'hire', tool: 'Hire an agent', ok: true, agentId: SAMPLE_AGENT_A, name: 'Companies House Lookup', priceUsd: '0.02', paidUsd: '0.020000' },
      { kind: 'helper', tool: 'Wallet Risk Screener', ok: true, name: 'Wallet Risk Screener', priceUsd: '0.03', paidUsd: '0.030000' },
    ],
  },
];

export const SAMPLE_ACTIVITY: ActivityItem[] = [
  { id: 'a1', kind: 'other', at: ago(12), ok: true, amountUsd: '0.15', title: 'Checked a supplier' },
  { id: 'a2', kind: 'you', at: ago(95), ok: true, amountUsd: '0.08', title: 'Check Johnson Matthey PLC and its wallet' },
  { id: 'a3', kind: 'other', at: ago(60 * 7), ok: true, amountUsd: '0.15', title: 'Checked a supplier' },
  { id: 'a4', kind: 'other', at: ago(60 * 26), ok: false, amountUsd: '0', title: 'Checked a supplier' },
  { id: 'a5', kind: 'you', at: ago(60 * 30), ok: true, amountUsd: '0.08', title: 'Is this address risky? 0x7a25…88D' },
];

/** What the scripted builder says in preview mode, in order. */
export const SAMPLE_BUILD = {
  idea: 'Check a new supplier before I pay them',
  reply: 'Got it. I will look up the company and screen the payment address. Two quick questions: do you usually pay in crypto, and do you want a short verdict or a full report?',
  followUp: 'Short verdict, and yes, mostly crypto.',
  plan: 'Perfect. I found two helpers that fit. Building your agent now.',
  agent: {
    name: 'Supplier Check',
    does: 'Checks a new supplier and its payment address before you pay them, and gives a short verdict.',
    costUsd: '0.08',
    helpers: SAMPLE_HELPERS,
  },
} as const;

/** What the scripted edit says in preview mode (the Make changes tab). */
export const SAMPLE_EDIT = {
  suggestion: 'Also check sanctions lists',
  reply: 'Done. I added a sanctions check to your agent and tried it on a sample supplier: it came back clean. Your live agent now uses the change.',
} as const;

// --- S5.3: the scripted build and change, as the same events a real build sends, so preview mode shows the same
// picture filling in. Each entry waits `ms`, then applies the event.
type Scripted = [ms: number, event: BuildEvent];

const sampleParts = (state: PartState, tools: Part[] = [], main: PartState = state): Part[] => [
  { id: 'network', kind: 'network', state: main === 'used' || main === 'testing' ? 'ready' : main },
  { id: 'chat', kind: 'chat', state: main },
  { id: 'request', kind: 'request', state: main },
  { id: 'brain', kind: 'brain', state: main },
  ...tools,
  { id: 'answer', kind: 'answer', state: main },
];
const sampleTools = (state: PartState, cost = false): Part[] =>
  SAMPLE_HELPERS.map((h) => ({ id: `tool:${h.name}`, kind: 'helper', label: h.name, detail: h.what, priceUsd: h.priceUsd, state, ...(cost ? { costUsd: h.priceUsd } : {}) }));
const act = (id: string, label: string, state: Activity['state'] = 'running'): BuildEvent => ({ type: 'activity', activity: { id, label, state } });

/** The first message: the builder asks two questions and names the agent. */
export const SAMPLE_BUILD_ASK: Scripted[] = [
  [700, { type: 'text', delta: SAMPLE_BUILD.reply }],
  [200, { type: 'done' }],
];

/** The follow-up: find helpers, plan, build, try it, ready. */
export function sampleBuildScript(): Scripted[] {
  const b = copy.build;
  const preview = { name: SAMPLE_BUILD.agent.name, does: SAMPLE_BUILD.agent.does, helpers: [...SAMPLE_HELPERS], costUsd: SAMPLE_BUILD.agent.costUsd, suggestedPriceUsd: '0.15' };
  return [
    [500, { type: 'progress', step: 'finding' }],
    [0, act('s1', b.searching('company registry check'))],
    [900, act('s1', b.found('3'), 'done')],
    [200, act('s2', b.searching('crypto address risk'))],
    [900, act('s2', b.found('2'), 'done')],
    [300, { type: 'text', delta: SAMPLE_BUILD.plan }],
    [300, { type: 'preview', preview }],
    [0, { type: 'blueprint', parts: sampleParts('planned', sampleTools('planned')) }],
    [0, act('s3', b.planned(SAMPLE_BUILD.agent.name), 'done')],
    [600, { type: 'progress', step: 'building' }],
    [0, act('s4', b.saving)],
    [0, { type: 'blueprint', parts: sampleParts('building', sampleTools('building')) }],
    [1400, { type: 'blueprint', parts: sampleParts('ready', sampleTools('ready')) }],
    [0, act('s4', b.saved, 'done')],
    [500, { type: 'progress', step: 'testing' }],
    [0, act('s5', b.trying('Check Acme Trading Ltd, paying to 0x52…a1'))],
    [0, { type: 'blueprint', parts: sampleParts('testing', sampleTools('testing')) }],
    [1800, act('s6', b.helperUsed('Counterparty Check', '$0.05'), 'done')],
    [600, act('s7', b.helperUsed('Wallet Risk Screener', '$0.03'), 'done')],
    [400, { type: 'blueprint', parts: sampleParts('ready', sampleTools('used', true), 'used') }],
    [0, act('s5', b.answered('Check Acme Trading Ltd, paying to 0x52…a1', '7'), 'done')],
    [500, { type: 'progress', step: 'ready' }],
    [0, act('s8', b.ready, 'done')],
    [0, { type: 'text', delta: `\n\n${copy.create.ready}` }],
    [100, { type: 'done' }],
  ];
}

/** The Make changes tab: read the agent, add a sanctions helper, try it, and the change goes live. */
export function sampleEditScript(): Scripted[] {
  const b = copy.build;
  const sanctions: Part = { id: 'tool:Sanctions Screen', kind: 'helper', label: 'Sanctions Screen', detail: 'Checks a name against sanctions lists', priceUsd: '0.02', state: 'ready' };
  return [
    [400, { type: 'progress', step: 'building' }],
    [0, act('e1', b.reading)],
    [700, { type: 'blueprint', parts: sampleParts('ready', sampleTools('ready')) }],
    [0, act('e1', b.reading, 'done')],
    [300, act('e2', b.searching('sanctions list check'))],
    [800, act('e2', b.found('1'), 'done')],
    [200, act('e3', b.changing)],
    [0, { type: 'blueprint', parts: sampleParts('ready', [...sampleTools('ready'), { ...sanctions, state: 'building' }]) }],
    [1100, { type: 'blueprint', parts: sampleParts('ready', [...sampleTools('ready'), sanctions]) }],
    [0, act('e3', b.changed, 'done')],
    [400, { type: 'progress', step: 'testing' }],
    [0, act('e4', b.trying('Check Acme Trading Ltd'))],
    [0, { type: 'blueprint', parts: sampleParts('testing', [...sampleTools('testing'), { ...sanctions, state: 'testing' }]) }],
    [1600, act('e5', b.helperUsed('Sanctions Screen', '$0.02'), 'done')],
    [300, { type: 'blueprint', parts: sampleParts('ready', [...sampleTools('ready'), { ...sanctions, state: 'used', costUsd: '0.02' }], 'used') }],
    [0, act('e4', b.answered('Check Acme Trading Ltd', '5'), 'done')],
    [400, { type: 'progress', step: 'ready' }],
    [0, act('e6', b.ready, 'done')],
    [0, { type: 'text', delta: SAMPLE_EDIT.reply }],
    [100, { type: 'done' }],
  ];
}

// Sample data for preview mode (STUDIO_PREVIEW=1): what the screens look like with three agents and some use.
import type { ActivityItem, Agent, ChatTurn, Helper } from './types';

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

export const SAMPLE_CHAT: ChatTurn[] = [
  { role: 'user', text: 'Check Johnson Matthey PLC and the wallet 0xd8dA…6045 before I pay their invoice.' },
  {
    role: 'agent',
    text:
      'Johnson Matthey PLC is a registered UK company (number 00033774) and looks active. The wallet has no history with sanctioned services or mixers, so the payment looks low risk.\n\nI would go ahead, and keep the receipt for your records.',
    used: { helpers: 2, costUsd: '0.08' },
    details: ['Counterparty Check · $0.05 · answered in 4 s', 'Wallet Risk Screener · $0.03 · answered in 3 s'],
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

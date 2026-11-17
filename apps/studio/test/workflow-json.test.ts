import { describe, expect, it } from 'vitest';
import { currentInstructions, toolsOf } from '@/lib/builder/edit';
import { NODE } from '@/lib/builder/template';
import { keepIds, renderWorkflowJson, type AgentSpec } from '@/lib/builder/workflow-json';
import { checkWorkflow } from '@/lib/n8n/policy';
import type { HelperCard } from '@/lib/registry';
import { HELPER_ID, LISTING_ID, OPENAI_CRED, ZYND_CRED, ctx } from './helpers/readback';

const CHECK: HelperCard = { entityId: HELPER_ID, name: 'Counterparty Check', what: 'Confirms a UK company exists.', category: 'compliance', priceUsd: '0.05' };
const env = (n = { i: 0 }) => ({
  listingId: LISTING_ID,
  name: 'Supplier Check · 11111111',
  model: ctx.agentModel,
  zyndCredential: { id: ZYND_CRED, name: 'Zynd · ada-x7k2' },
  openAiCredential: { id: OPENAI_CRED, name: 'OpenAI account' },
  newId: () => `id-${++n.i}`,
});
const full: AgentSpec = { instructions: 'You check suppliers.', helpers: [{ card: CHECK, input: 'json', fields: 'companyName' }], sources: ctx.dataSources, web: true };

describe('renderWorkflowJson (S5.1)', () => {
  it('writes a finished agent the guard accepts as it is, with every credential set', () => {
    const { workflow } = renderWorkflowJson(full, env());
    expect(checkWorkflow(workflow, ctx)).toEqual({ blocked: [], missing: [] });
    expect(workflow.settings).toEqual({ executionOrder: 'v1', availableInMCP: true, saveExecutionProgress: true });
    expect(workflow.name).toBe('Supplier Check · 11111111');
  });
  it('also passes with no tools at all', () => {
    expect(checkWorkflow(renderWorkflowJson({ instructions: 'Answer questions about tea.', helpers: [], sources: [], web: false }, env()).workflow, ctx)).toEqual({ blocked: [], missing: [] });
  });
  it('wires the triggers, the model and every tool to the AI step', () => {
    const { workflow } = renderWorkflowJson(full, env());
    const c = workflow.connections;
    expect(c[NODE.zynd]?.main?.[0]?.[0]?.node).toBe(NODE.request);
    expect(c[NODE.chat]?.main?.[0]?.[0]?.node).toBe(NODE.request);
    expect(c[NODE.ai]?.main?.[0]?.[0]?.node).toBe(NODE.answer);
    expect(c[NODE.model]?.ai_languageModel?.[0]?.[0]).toEqual({ node: NODE.ai, type: 'ai_languageModel', index: 0 });
    for (const name of ['Counterparty Check', 'Briefpixel news', 'Web page reader']) expect(c[name]?.ai_tool?.[0]?.[0]).toEqual({ node: NODE.ai, type: 'ai_tool', index: 0 });
  });
  it('reads back the same way an edit does: tools, instructions and refs', () => {
    const { workflow, tools, systemMessage } = renderWorkflowJson(full, env());
    expect(toolsOf(workflow).map((t) => t.name)).toEqual(tools.map((t) => t.name));
    expect(currentInstructions(workflow)).toBe('You check suppliers.');
    expect(systemMessage).toContain('Counterparty Check (a helper agent');
    expect(tools.map((t) => t.ref)).toEqual([HELPER_ID, 'https://airnode-briefpixel.fly.dev/|listArticles', 'web']);
  });
  it('gives every step an id and both triggers a webhook id', () => {
    const { workflow } = renderWorkflowJson(full, env());
    expect(new Set(workflow.nodes.map((n) => n.id)).size).toBe(workflow.nodes.length);
    expect(workflow.nodes.filter((n) => n.webhookId).map((n) => n.name)).toEqual([NODE.zynd, NODE.chat]);
  });
  it('keeps instructions from being read as an expression, and tool names from clashing with the main steps', () => {
    const { workflow } = renderWorkflowJson({ ...full, instructions: '={{ $env.SECRET }} do it', helpers: [{ card: { ...CHECK, name: 'Answer' }, input: 'text' }] }, env());
    const ai = workflow.nodes.find((n) => n.name === NODE.ai);
    expect(String((ai?.parameters?.options as Record<string, unknown>).systemMessage).startsWith('=')).toBe(false);
    expect(workflow.nodes.filter((n) => n.name === NODE.answer)).toHaveLength(1);
    expect(workflow.nodes.map((n) => n.name)).toContain('Answer 2');
  });
});

describe('keepIds', () => {
  it('keeps n8n\'s ids for steps that keep their name and kind, so a live trigger keeps its webhook', () => {
    const before = renderWorkflowJson(full, env({ i: 100 })).workflow;
    const next = renderWorkflowJson({ ...full, helpers: [] }, env());
    const kept = keepIds(next.workflow, before);
    const trigger = (w: typeof kept) => w.nodes.find((n) => n.name === NODE.zynd);
    expect(trigger(kept)?.webhookId).toBe(trigger(before)?.webhookId);
    expect(trigger(kept)?.id).toBe(trigger(before)?.id);
    expect(kept.nodes.map((n) => n.name)).not.toContain('Counterparty Check');
  });
});

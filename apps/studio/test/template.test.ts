import { describe, expect, it } from 'vitest';
import { NODE, renderTemplate, systemMessage, type TemplateInput } from '@/lib/builder/template';
import { checkWorkflow } from '@/lib/n8n/policy';
import { interpret } from './helpers/interpret';
import { HELPER_ID, LISTING_ID, OPENAI_CRED, ZYND_CRED, ctx } from './helpers/readback';

const input = (over: Partial<TemplateInput> = {}): TemplateInput => ({
  listingId: LISTING_ID,
  zyndCredentialName: 'Zynd · ada-x7k2',
  openAiCredentialName: 'OpenAI account',
  model: 'gpt-5-mini',
  name: 'Supplier Check · 11111111',
  instructions: 'You check a new supplier before payment. Ask for the company name and wallet. Reply with a short verdict.',
  helpers: [{ entityId: HELPER_ID, name: 'Counterparty Check', what: 'Confirms a UK company exists.', maxPriceUsd: '0.05', input: 'json', fields: 'companyName, companyNumber, lei' }],
  sources: [{ name: 'Briefpixel news', listingUrl: 'https://airnode-briefpixel.fly.dev/', operation: 'listArticles', what: 'Recent news about a company.', maxPriceUsd: '0.01', fields: 'q, limit' }],
  web: true,
  ...over,
});
const ids = { 'Zynd · ada-x7k2': ZYND_CRED, 'OpenAI account': OPENAI_CRED };
const render = (over: Partial<TemplateInput> = {}) => renderTemplate(input(over));

describe('renderTemplate', () => {
  it('is code the policy accepts as a finished agent, with every id injected (template and policy agree)', () => {
    const wf = interpret(render(), ids);
    expect(wf.nodes.map((n) => n.name).sort()).toEqual(
      [NODE.zynd, NODE.chat, NODE.request, NODE.ai, NODE.answer, NODE.model, 'Counterparty Check', 'Briefpixel news', 'Web page reader'].sort(),
    );
    expect(checkWorkflow(wf, ctx)).toEqual({ blocked: [], missing: [] });
  });

  it('wires both triggers into the same request step, then the AI step, then the answer', () => {
    const wf = interpret(render(), ids);
    expect(wf.connections).toEqual({
      [NODE.zynd]: { main: [[{ node: NODE.request }]] },
      [NODE.chat]: { main: [[{ node: NODE.request }]] },
      [NODE.request]: { main: [[{ node: NODE.ai }]] },
      [NODE.ai]: { main: [[{ node: NODE.answer }]] },
    });
  });

  it('pays every helper and data source from this agent\'s own wallet, with a fixed id and price', () => {
    const wf = interpret(render(), ids);
    const helper = wf.nodes.find((n) => n.name === 'Counterparty Check');
    expect(helper?.parameters).toMatchObject({ operation: 'callAgent', agentId: HELPER_ID, maxPaymentUsd: '0.05', payFrom: 'listing', payFromListingId: LISTING_ID, inputType: 'json' });
    const source = wf.nodes.find((n) => n.name === 'Briefpixel news');
    expect(source?.parameters).toMatchObject({ operation: 'call', listingUrl: 'https://airnode-briefpixel.fly.dev/', airnodeOperation: 'listArticles', maxPaymentUsd: '0.01', payFrom: 'listing', payFromListingId: LISTING_ID });
    // What the AI fills in is left to the AI; everything that costs money is fixed.
    expect(helper?.parameters?.inputJson).toContain('$fromAI');
    expect(helper?.parameters?.agentId).not.toContain('$');
  });

  it('leaves out what was not asked for', () => {
    const wf = interpret(render({ helpers: [], sources: [], web: false }), ids);
    expect(wf.nodes.map((n) => n.name).sort()).toEqual([NODE.zynd, NODE.chat, NODE.request, NODE.ai, NODE.answer, NODE.model].sort());
    expect(checkWorkflow(wf, ctx).blocked).toEqual([]);
    expect(render({ helpers: [], sources: [], web: false })).not.toContain('tools:');
  });

  it('names text helpers and JSON helpers differently', () => {
    const wf = interpret(render({ helpers: [{ entityId: HELPER_ID, name: 'Summariser', what: 'Summarises text.', maxPriceUsd: '0.02', input: 'text' }], sources: [], web: false }), ids);
    const p = wf.nodes.find((n) => n.name === 'Summariser')?.parameters;
    expect(p).toMatchObject({ inputType: 'text' });
    expect(String(p?.inputText)).toContain('$fromAI');
    expect(p).not.toHaveProperty('inputJson');
  });

  it('keeps every piece of text from breaking the code', () => {
    const nasty = 'Say "hi"\n`${process.exit()}` \\   end';
    const code = render({ name: nasty, instructions: nasty, helpers: [{ entityId: HELPER_ID, name: nasty, what: nasty, maxPriceUsd: '0.05', input: 'json', fields: nasty }], web: false });
    const wf = interpret(code, ids); // compiles and runs without an error
    expect(wf.nodes.length).toBeGreaterThan(5);
    expect(JSON.stringify(wf)).toContain('process.exit()');
    expect(checkWorkflow(wf, ctx).blocked).toEqual([]);
  });

  it('gives two helpers with the same name different tool names', () => {
    const h = { entityId: HELPER_ID, name: 'Checker', what: 'x', maxPriceUsd: '0.05', input: 'text' as const };
    const wf = interpret(render({ helpers: [h, { ...h, entityId: 'zns:ffffffffffffffffffffffffffffffff' }], sources: [], web: false }), ids);
    expect(wf.nodes.filter((n) => n.name.startsWith('Checker')).map((n) => n.name)).toEqual(['Checker', 'Checker 2']);
  });
});

describe('systemMessage', () => {
  it('lists the tools by name and asks for plain answers', () => {
    const m = systemMessage(input());
    expect(m).toContain('You check a new supplier');
    expect(m).toContain('Counterparty Check');
    expect(m).toContain('Briefpixel news');
    expect(m).toContain('Web page reader');
    expect(m).toMatch(/plain, short sentences/);
  });
  it('has no tools line when there are none', () => {
    expect(systemMessage({ instructions: 'Do it.', helpers: [], sources: [], web: false })).not.toContain('Tools you can use');
  });
});

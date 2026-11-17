import { describe, expect, it } from 'vitest';
import { NODE } from '@/lib/builder/template';
import { ALLOWED_NODE_TYPES, checkWorkflow, credentialFixes, isInternalHost, type N8nNode } from '@/lib/n8n/policy';
import { HELPER_ID, LISTING_ID, OPENAI_CRED, ZYND_CRED, ctx, goodWorkflow, nodeNamed } from './helpers/readback';

const check = (change?: (n: N8nNode[]) => N8nNode[] | void) => checkWorkflow(goodWorkflow(change), ctx);
const blocked = (change: (n: N8nNode[]) => N8nNode[] | void) => check(change).blocked.join(' | ');

describe('checkWorkflow: a finished agent', () => {
  it('passes the template exactly as n8n reads it back', () => {
    expect(check()).toEqual({ blocked: [], missing: [] });
  });
  it('allows plain extra steps, and a paused (disabled) step', () => {
    const r = check((n) => {
      n.push({ name: 'Only long requests', type: 'n8n-nodes-base.if', typeVersion: 2.2, parameters: {} });
      n.push({ name: 'Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, parameters: {} });
      nodeNamed(n, 'Web page reader').disabled = true;
    });
    expect(r.blocked).toEqual([]);
  });
});

describe('checkWorkflow: what is never allowed (S2.3 exit gate)', () => {
  it.each(['n8n-nodes-base.code', 'n8n-nodes-base.executeCommand', 'n8n-nodes-base.ssh', 'n8n-nodes-base.readWriteFile', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.postgres', 'CUSTOM.zynd', 'CUSTOM.zyndAirnode', '@n8n/n8n-nodes-langchain.toolCode'])(
    'refuses a %s step',
    (type) => {
      const why = blocked((n) => void n.push({ name: 'Sneaky', type, typeVersion: 1, parameters: {} }));
      expect(why).toContain('Step "Sneaky"');
      expect(why).toContain(type);
    },
  );

  it('refuses a credential that is not this person\'s (another person\'s Zynd credential)', () => {
    const why = blocked((n) => {
      nodeNamed(n, NODE.zynd).credentials = { zyndApi: { id: 'cred-zynd-someone-else', name: 'Zynd · grace-q1w2' } };
    });
    expect(why).toContain('does not belong to this agent');
  });
  it('refuses a credential that is not the platform\'s OpenAI one', () => {
    expect(blocked((n) => void (nodeNamed(n, NODE.model).credentials = { openAiApi: { id: 'cred-my-own-key', name: 'x' } }))).toContain('does not belong to this agent');
  });
  it('refuses any other kind of credential, on any step', () => {
    expect(blocked((n) => void (nodeNamed(n, 'Web page reader').credentials = { httpHeaderAuth: { id: 'h1', name: 'secret' } }))).toContain('credential of type "httpHeaderAuth"');
    expect(blocked((n) => void (nodeNamed(n, NODE.request).credentials = { zyndApi: { id: ZYND_CRED, name: 'x' } }))).toContain('credential of type "zyndApi"');
    expect(blocked((n) => void (nodeNamed(n, NODE.model).credentials = { openAiApi: { id: OPENAI_CRED, name: 'x' }, zyndApi: { id: ZYND_CRED, name: 'x' } }))).toContain('credential of type "zyndApi"');
  });
  it('refuses a Zynd Trigger bound to another listing, or to extra ones', () => {
    expect(blocked((n) => void (nodeNamed(n, NODE.zynd).parameters = { listingId: 'another-listing', responseMode: 'lastNode' }))).toContain('must serve this agent only');
    expect(blocked((n) => void (nodeNamed(n, NODE.zynd).parameters = { listingId: LISTING_ID, additionalListingIds: ['other'], responseMode: 'lastNode' }))).toContain('extra listings');
  });
  it('refuses a second Zynd Trigger', () => {
    expect(blocked((n) => void n.push({ ...nodeNamed(n, NODE.zynd), name: 'Another trigger' }))).toContain('Only one Zynd Trigger');
  });
  it('refuses a public chat link, which would let anyone spend the credit', () => {
    expect(blocked((n) => void (nodeNamed(n, NODE.chat).parameters = { public: true }))).toContain('must not be public');
  });
  it('refuses an error workflow, and more steps than the cap', () => {
    const wf = goodWorkflow();
    expect(checkWorkflow({ ...wf, settings: { errorWorkflow: 'abc' } }, ctx).blocked.join()).toContain('error workflow');
    const many = goodWorkflow((n) => void Array.from({ length: 30 }, (_, i) => n.push({ name: `Note ${i}`, type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} })));
    expect(checkWorkflow(many, ctx).blocked.join()).toContain('at most 30');
  });
});

describe('checkWorkflow: paying helpers and data sources', () => {
  const helper = (n: N8nNode[]) => nodeNamed(n, 'Counterparty Check');
  it('refuses a helper that pays from the developer wallet or another agent\'s wallet', () => {
    expect(blocked((n) => void (helper(n).parameters = { ...helper(n).parameters, payFrom: 'developer' }))).toContain("own wallet");
    expect(blocked((n) => void (helper(n).parameters = { ...helper(n).parameters, payFromListingId: 'someone-elses-listing' }))).toContain('own wallet');
    expect(blocked((n) => void (helper(n).parameters = { ...helper(n).parameters, payFromListingId: '={{ $json.listingId }}' }))).toContain('own wallet');
  });
  it('refuses a helper chosen by an expression, or an operation other than callAgent', () => {
    expect(blocked((n) => void (helper(n).parameters = { ...helper(n).parameters, agentId: '={{ $json.who }}' }))).toContain('one fixed helper');
    expect(blocked((n) => void (helper(n).parameters = { ...helper(n).parameters, operation: 'listListings' }))).toContain('callAgent');
  });
  it('needs a fixed maximum price, within the cap', () => {
    expect(blocked((n) => void (helper(n).parameters = { ...helper(n).parameters, maxPaymentUsd: '' }))).toContain('fixed maxPaymentUsd');
    expect(blocked((n) => void (helper(n).parameters = { ...helper(n).parameters, maxPaymentUsd: '={{ 5 }}' }))).toContain('fixed maxPaymentUsd');
    expect(blocked((n) => void (helper(n).parameters = { ...helper(n).parameters, maxPaymentUsd: '5' }))).toContain('at most $0.25');
    expect(blocked((n) => void (helper(n).parameters = { ...helper(n).parameters, maxPaymentUsd: '0.25' }))).toBe('');
  });
  it('only lets a data-source step use an offered source and operation', () => {
    const source = (n: N8nNode[]) => nodeNamed(n, 'Briefpixel news');
    expect(blocked((n) => void (source(n).parameters = { ...source(n).parameters, listingUrl: 'https://airnode-evil.fly.dev/' }))).toContain('offered data sources');
    expect(blocked((n) => void (source(n).parameters = { ...source(n).parameters, airnodeOperation: 'deleteEverything' }))).toContain('offered data sources');
    expect(blocked((n) => void (source(n).parameters = { ...source(n).parameters, airnodeOperation: '={{ $json.op }}' }))).toContain('offered data sources');
    expect(blocked((n) => void (source(n).parameters = { ...source(n).parameters, operation: 'verify' }))).toContain('operation "call"');
  });
});

describe('checkWorkflow: the web tool and the model', () => {
  const web = (n: N8nNode[]) => nodeNamed(n, 'Web page reader');
  it('is read-only, without keys, and not aimed at internal addresses', () => {
    expect(blocked((n) => void (web(n).parameters = { ...web(n).parameters, method: 'POST' }))).toContain('only read');
    expect(blocked((n) => void (web(n).parameters = { ...web(n).parameters, authentication: 'predefinedCredentialType' }))).toContain('authentication');
    expect(blocked((n) => void (web(n).parameters = { ...web(n).parameters, sendBody: true }))).toContain('body');
    expect(blocked((n) => void (web(n).parameters = { ...web(n).parameters, url: 'http://169.254.169.254/latest/meta-data' }))).toContain('internal address');
    expect(blocked((n) => void (web(n).parameters = { ...web(n).parameters, url: 'http://localhost:8090/internal/v1/api-keys' }))).toContain('internal address');
    expect(blocked((n) => void (web(n).parameters = { ...web(n).parameters, url: 'file:///etc/passwd' }))).toContain('not a web address');
    expect(blocked((n) => void (web(n).parameters = { ...web(n).parameters, url: 'https://example.com/data.json' }))).toBe('');
  });
  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.20.0.5', true],
    ['172.32.0.5', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['n8n', true],
    ['gateway.internal', true],
    ['[::1]', true],
    ['example.com', false],
    ['8.8.8.8', false],
  ])('isInternalHost(%s) = %s', (host, internal) => {
    expect(isInternalHost(host)).toBe(internal);
  });
  it('keeps the agent on the one model, with no built-in tools', () => {
    expect(blocked((n) => void (nodeNamed(n, NODE.model).parameters = { model: { __rl: true, mode: 'id', value: 'o3-pro' } }))).toContain('must use the model "gpt-5-mini"');
    expect(blocked((n) => void (nodeNamed(n, NODE.model).parameters = { model: { __rl: true, mode: 'id', value: 'gpt-5-mini' }, builtInTools: { codeInterpreter: true } }))).toContain('built-in tools');
    expect(blocked((n) => void (nodeNamed(n, NODE.model).parameters = { builtInTools: {} }))).toBe('');
  });
  it('lists the allowed kinds without anything that runs code or touches files', () => {
    expect(ALLOWED_NODE_TYPES.some((t) => /code|execute|ssh|file|postgres|mysql|httpRequest$/i.test(t) && !t.endsWith('toolCalculator'))).toBe(false);
  });
});

describe('checkWorkflow: missing parts (safe, but not a finished agent)', () => {
  it('names what to add or keep', () => {
    const m = (change: (n: N8nNode[]) => N8nNode[]) => check(change).missing.join(' | ');
    expect(m((n) => n.filter((x) => x.name !== NODE.zynd))).toContain('Zynd Trigger');
    expect(m((n) => n.filter((x) => x.name !== NODE.chat))).toContain('Chat Trigger');
    expect(m((n) => n.filter((x) => x.name !== NODE.answer))).toContain('Answer');
    expect(m((n) => n.map((x) => (x.name === NODE.ai ? { ...x, name: 'Brain' } : x)))).toContain('AI agent step');
  });
  it('needs intermediate steps on, the response mode and the credentials in place', () => {
    expect(check((n) => void (nodeNamed(n, NODE.ai).parameters = { options: {} })).missing.join()).toContain('returnIntermediateSteps');
    expect(check((n) => void (nodeNamed(n, NODE.zynd).parameters = { listingId: LISTING_ID, responseMode: 'onReceived' })).missing.join()).toContain('lastNode');
    expect(check((n) => void delete nodeNamed(n, 'Counterparty Check').credentials).missing.join()).toContain('no zyndApi credential');
  });
  it('needs both triggers connected', () => {
    const wf = goodWorkflow();
    delete wf.connections?.[NODE.chat];
    expect(checkWorkflow(wf, ctx).missing.join()).toContain('"Chat Trigger" is not connected');
  });
});

describe('checkWorkflow: helper ids are checked as ids', () => {
  it('accepts the showcase helper id', () => expect(HELPER_ID).toMatch(/^zns:/));
});

describe('credentialFixes: Studio sets the credentials itself', () => {
  it('asks for nothing when every step already has the right credential', () => {
    expect(credentialFixes(goodWorkflow(), ctx)).toEqual([]);
  });
  it('sets the person\'s Zynd credential and the platform OpenAI credential where n8n chose another or none', () => {
    const wf = goodWorkflow((n) => {
      nodeNamed(n, NODE.zynd).credentials = { zyndApi: { id: 'showcase', name: 'Zynd account' } };
      delete nodeNamed(n, 'Counterparty Check').credentials;
      nodeNamed(n, NODE.model).credentials = { openAiApi: { id: 'other-openai', name: 'Someone' } };
    });
    const ops = credentialFixes(wf, ctx);
    expect(ops).toEqual([
      { type: 'setNodeCredential', nodeName: NODE.zynd, credentialKey: 'zyndApi', credentialId: ZYND_CRED, credentialName: 'Zynd · ada-x7k2' },
      { type: 'setNodeCredential', nodeName: NODE.model, credentialKey: 'openAiApi', credentialId: OPENAI_CRED, credentialName: 'OpenAI account' },
      { type: 'setNodeCredential', nodeName: 'Counterparty Check', credentialKey: 'zyndApi', credentialId: ZYND_CRED, credentialName: 'Zynd · ada-x7k2' },
    ]);
  });
  it('never touches a credential type the step does not need, or a step that is not allowed: the check blocks those', () => {
    const wf = goodWorkflow((n) => {
      nodeNamed(n, NODE.request).credentials = { httpHeaderAuth: { id: 'k', name: 'key' } };
      n.push({ name: 'Run code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {}, credentials: { zyndApi: { id: 'x', name: 'x' } } });
    });
    expect(credentialFixes(wf, ctx)).toEqual([]);
    expect(checkWorkflow(wf, ctx).blocked.length).toBe(2);
  });
});

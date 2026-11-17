// A workflow as n8n's `get_workflow_details` returns it for an agent built from the Studio template. Copied from a
// real read-back (2026-11-16, n8n 2.x): node types, parameter names, credential references and the connection format
// are exactly what n8n gave, with neutral ids.
import { NODE } from '../../lib/builder/template';
import type { N8nNode, N8nWorkflow, PolicyContext } from '../../lib/n8n/policy';

export const LISTING_ID = '11111111-2222-4333-8444-555555555555';
export const ZYND_CRED = 'cred-zynd-ada';
export const OPENAI_CRED = 'cred-openai-platform';
export const HELPER_ID = 'zns:0ee8bb9aaa5d8f682756b6eba5591855';

export const ctx: PolicyContext = {
  listingId: LISTING_ID,
  zyndCredentialId: ZYND_CRED,
  openAiCredentialId: OPENAI_CRED,
  zyndCredentialName: 'Zynd · ada-x7k2',
  openAiCredentialName: 'OpenAI account',
  agentModel: 'gpt-5-mini',
  dataSources: [{ name: 'Briefpixel news', listingUrl: 'https://airnode-briefpixel.fly.dev/', operation: 'listArticles', what: 'News', maxPriceUsd: '0.01' }],
  maxCallPriceUsd: '0.25',
};

const zynd = { zyndApi: { id: ZYND_CRED, name: 'Zynd · ada-x7k2' } };

export const baseNodes = (): N8nNode[] => [
  { name: NODE.zynd, type: 'CUSTOM.zyndTrigger', typeVersion: 1, parameters: { listingId: LISTING_ID, responseMode: 'lastNode' }, credentials: zynd },
  { name: NODE.request, type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: { mode: 'manual', assignments: { assignments: [{ id: 'request', name: 'request', value: '={{ $json.chatInput }}', type: 'string' }] }, includeOtherFields: false } },
  { name: NODE.ai, type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3.1, parameters: { promptType: 'define', text: '={{ $json.request }}', options: { systemMessage: 'You check suppliers.', returnIntermediateSteps: true, maxIterations: 8 } } },
  { name: NODE.model, type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.3, parameters: { model: { __rl: true, mode: 'id', value: 'gpt-5-mini' } }, credentials: { openAiApi: { id: OPENAI_CRED, name: 'OpenAI account' } } },
  {
    name: 'Counterparty Check',
    type: 'CUSTOM.zyndTool',
    typeVersion: 1,
    parameters: {
      descriptionType: 'manual',
      toolDescription: 'Confirms a UK company exists.',
      operation: 'callAgent',
      agentId: HELPER_ID,
      inputType: 'json',
      inputJson: "={{ /*n8n-auto-generated-fromAI-override*/ $fromAI('input', 'A JSON object') }}",
      maxPaymentUsd: '0.05',
      payFrom: 'listing',
      payFromListingId: LISTING_ID,
    },
    credentials: zynd,
  },
  {
    name: 'Briefpixel news',
    type: 'CUSTOM.zyndAirnodeTool',
    typeVersion: 1,
    parameters: {
      descriptionType: 'manual',
      operation: 'call',
      listingUrl: 'https://airnode-briefpixel.fly.dev/',
      airnodeOperation: 'listArticles',
      airnodeParameters: "={{ /*n8n-auto-generated-fromAI-override*/ $fromAI('parameters', 'JSON') }}",
      maxPaymentUsd: '0.01',
      payFrom: 'listing',
      payFromListingId: LISTING_ID,
    },
    credentials: zynd,
  },
  {
    name: 'Web page reader',
    type: 'n8n-nodes-base.httpRequestTool',
    typeVersion: 4.5,
    parameters: { method: 'GET', url: "={{ /*n8n-auto-generated-fromAI-override*/ $fromAI('url', 'address') }}", authentication: 'none', optimizeResponse: true, responseType: 'text' },
  },
  { name: NODE.answer, type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: { mode: 'manual', assignments: { assignments: [{ id: 'output', name: 'output', value: '={{ $json.output }}', type: 'string' }] }, includeOtherFields: false } },
  { name: NODE.chat, type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.5, parameters: {} },
];

export const baseConnections = (): NonNullable<N8nWorkflow['connections']> => ({
  [NODE.zynd]: { main: [[{ node: NODE.request }]] },
  [NODE.chat]: { main: [[{ node: NODE.request }]] },
  [NODE.request]: { main: [[{ node: NODE.ai }]] },
  [NODE.ai]: { main: [[{ node: NODE.answer }]] },
});

/** A finished, allowed agent. Tests change one thing in it at a time. */
export function goodWorkflow(change: (nodes: N8nNode[]) => N8nNode[] | void = () => undefined): N8nWorkflow {
  const nodes = baseNodes();
  const out = change(nodes) ?? nodes;
  return { id: 'wf-1', name: 'Supplier Check', nodes: out, connections: baseConnections(), settings: { executionOrder: 'v1', availableInMCP: true } };
}

export const nodeNamed = (nodes: N8nNode[], name: string): N8nNode => nodes.find((n) => n.name === name) as N8nNode;

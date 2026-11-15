// The one workflow shape every Studio agent has (plan, "Agent workflow template"):
//
//   Zynd Trigger ─┐
//                 ├─► Request ─► AI step ─► Answer
//   Chat Trigger ─┘
//
// `renderTemplate` writes it as n8n Workflow SDK code with Studio's ids already injected. The builder starts from
// that text, may add plain steps, and submits it through the guarded relay. Everything here is plain strings, so it
// can be tested without n8n.

/** Node names other modules rely on (the policy, the run reader). The builder must keep them. */
export const NODE = {
  zynd: 'Zynd Trigger',
  chat: 'Chat Trigger',
  request: 'Request',
  ai: 'AI step',
  answer: 'Answer',
  model: 'OpenAI Chat Model',
} as const;

export interface TemplateHelper {
  /** The helper's entity id on the network (`zns:…`). Fixed in the tool, never chosen by the AI. */
  entityId: string;
  name: string;
  /** What the helper does, in a sentence. Shown to the AI as the tool description. */
  what: string;
  /** The most one call may cost, in USD. */
  maxPriceUsd: string;
  /** How the helper wants its input. `json` helpers take a JSON object with the fields in `fields`. */
  input: 'text' | 'json';
  fields?: string;
}

export interface TemplateSource {
  name: string;
  /** The AirnodeHub listing root, e.g. `https://airnode-gleif.fly.dev/`. */
  listingUrl: string;
  operation: string;
  what: string;
  maxPriceUsd: string;
  /** Parameter names the AI must fill, e.g. `lei, jurisdiction`. */
  fields?: string;
}

export interface TemplateInput {
  /** The agent's own listing id: what the trigger serves and which wallet pays for every call. */
  listingId: string;
  /** Name of the user's Zynd credential in n8n (`Zynd · <handle>`). */
  zyndCredentialName: string;
  /** Name of the platform's OpenAI credential in n8n. */
  openAiCredentialName: string;
  /** The OpenAI model the agent runs on. */
  model: string;
  /** Workflow name. */
  name: string;
  /** What the agent does and how it should answer: becomes the AI step's system message. */
  instructions: string;
  helpers: TemplateHelper[];
  sources: TemplateSource[];
  /** Give the agent a tool to read public web pages and APIs that need no key. */
  web: boolean;
}

/** A string as a JavaScript literal. JSON strings are valid JS, so nothing in the text can end the literal early. */
const lit = (s: string) => JSON.stringify(s);

const unique = (taken: Set<string>, base: string): string => {
  const clean = base.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 40) || 'Helper';
  let name = clean;
  for (let i = 2; taken.has(name); i++) name = `${clean} ${i}`;
  taken.add(name);
  return name;
};

/** The AI step's system message: the builder's instructions plus the facts only Studio knows. */
export function systemMessage(i: Pick<TemplateInput, 'instructions' | 'helpers' | 'sources' | 'web'>): string {
  const lines = [i.instructions.trim()];
  const tools = [
    ...i.helpers.map((h) => `${h.name} (a helper agent: ${h.what})`),
    ...i.sources.map((s) => `${s.name} (a data source: ${s.what})`),
    ...(i.web ? ['Web page reader (public pages and APIs that need no key)'] : []),
  ];
  if (tools.length) lines.push(`Tools you can use: ${tools.join('; ')}. Only use a tool when it helps with this request.`);
  lines.push(
    'Answer in plain, short sentences a non-technical person can follow. Never invent facts: if a tool failed or returned nothing, say so.',
  );
  return lines.join('\n\n');
}

/** The SDK code for the whole agent. */
export function renderTemplate(i: TemplateInput): string {
  const taken = new Set<string>([NODE.zynd, NODE.chat, NODE.request, NODE.ai, NODE.answer, NODE.model]);
  const out: string[] = [];
  const toolVars: string[] = [];

  out.push(`import { workflow, node, trigger, tool, languageModel, newCredential, fromAi, expr } from '@n8n/workflow-sdk';`);
  out.push('');
  out.push(`const zyndTrigger = trigger({
  type: 'CUSTOM.zyndTrigger',
  version: 1,
  config: {
    name: ${lit(NODE.zynd)},
    parameters: { listingId: ${lit(i.listingId)}, responseMode: 'lastNode' },
    credentials: { zyndApi: newCredential(${lit(i.zyndCredentialName)}) },
    position: [0, 0]
  },
  output: [{ jobId: 'job-1', listingId: ${lit(i.listingId)}, input: 'Hello' }]
});`);
  out.push('');
  out.push(`const chatTrigger = trigger({
  type: '@n8n/n8n-nodes-langchain.chatTrigger',
  version: 1.5,
  config: { name: ${lit(NODE.chat)}, parameters: {}, position: [0, 240] },
  output: [{ chatInput: 'Hello', sessionId: 'session-1' }]
});`);
  out.push('');
  out.push(`const requestStep = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: ${lit(NODE.request)},
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'request',
            name: 'request',
            value: expr(${lit("{{ $json.chatInput ?? (typeof $json.input === 'string' ? $json.input : JSON.stringify($json.input ?? {})) }}")}),
            type: 'string'
          }
        ]
      },
      includeOtherFields: false
    },
    position: [300, 120]
  },
  output: [{ request: 'Hello' }]
});`);
  out.push('');
  out.push(`const chatModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: ${lit(NODE.model)},
    parameters: { model: { __rl: true, mode: 'id', value: ${lit(i.model)} } },
    credentials: { openAiApi: newCredential(${lit(i.openAiCredentialName)}) }
  }
});`);

  i.helpers.forEach((h, n) => {
    const v = `helper${n + 1}`;
    toolVars.push(v);
    const name = unique(taken, h.name);
    const how =
      h.input === 'json'
        ? `Send a JSON object${h.fields ? ` with these fields: ${h.fields}` : ''}.`
        : 'Send a short plain-text request.';
    const input =
      h.input === 'json'
        ? `inputType: 'json',
      inputJson: fromAi('input', ${lit(`A JSON object for ${name}${h.fields ? ` with the fields ${h.fields}` : ''}`)}, 'string')`
        : `inputType: 'text',
      inputText: fromAi('request', ${lit(`What to ask ${name}, in plain words`)}, 'string')`;
    out.push('');
    out.push(`const ${v} = tool({
  type: 'CUSTOM.zyndTool',
  version: 1,
  config: {
    name: ${lit(name)},
    parameters: {
      descriptionType: 'manual',
      toolDescription: ${lit(`${h.what} ${how}`.slice(0, 500))},
      operation: 'callAgent',
      agentId: ${lit(h.entityId)},
      ${input},
      maxPaymentUsd: ${lit(h.maxPriceUsd)},
      payFrom: 'listing',
      payFromListingId: ${lit(i.listingId)}
    },
    credentials: { zyndApi: newCredential(${lit(i.zyndCredentialName)}) }
  }
});`);
  });

  i.sources.forEach((s, n) => {
    const v = `source${n + 1}`;
    toolVars.push(v);
    const name = unique(taken, s.name);
    out.push('');
    out.push(`const ${v} = tool({
  type: 'CUSTOM.zyndAirnodeTool',
  version: 1,
  config: {
    name: ${lit(name)},
    parameters: {
      descriptionType: 'manual',
      toolDescription: ${lit(`${s.what}${s.fields ? ` Parameters: ${s.fields}.` : ''}`.slice(0, 500))},
      operation: 'call',
      listingUrl: ${lit(s.listingUrl)},
      airnodeOperation: ${lit(s.operation)},
      airnodeParameters: fromAi('parameters', ${lit(`A JSON object of parameters for ${name}${s.fields ? `: ${s.fields}` : ''}`)}, 'string'),
      maxPaymentUsd: ${lit(s.maxPriceUsd)},
      payFrom: 'listing',
      payFromListingId: ${lit(i.listingId)}
    },
    credentials: { zyndApi: newCredential(${lit(i.zyndCredentialName)}) }
  }
});`);
  });

  if (i.web) {
    toolVars.push('webTool');
    out.push('');
    out.push(`const webTool = tool({
  type: 'n8n-nodes-base.httpRequestTool',
  version: 4.5,
  config: {
    name: 'Web page reader',
    parameters: {
      method: 'GET',
      url: fromAi('url', 'The full https address of a public web page or API that needs no key', 'string'),
      authentication: 'none',
      optimizeResponse: true,
      responseType: 'text',
      truncateResponse: true,
      maxLength: 6000
    }
  }
});`);
  }

  out.push('');
  out.push(`const aiStep = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: ${lit(NODE.ai)},
    parameters: {
      promptType: 'define',
      text: expr('{{ $json.request }}'),
      options: {
        systemMessage: ${lit(systemMessage(i))},
        returnIntermediateSteps: true,
        maxIterations: 8
      }
    },
    subnodes: { model: chatModel${toolVars.length ? `, tools: [${toolVars.join(', ')}]` : ''} },
    position: [600, 120]
  },
  output: [{ output: 'Hello', intermediateSteps: [] }]
});`);
  out.push('');
  out.push(`const answerStep = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: ${lit(NODE.answer)},
    parameters: {
      mode: 'manual',
      assignments: { assignments: [{ id: 'output', name: 'output', value: expr('{{ $json.output }}'), type: 'string' }] },
      includeOtherFields: false
    },
    position: [900, 120]
  },
  output: [{ output: 'Hello' }]
});`);
  out.push('');
  out.push(`export default workflow('studio-agent', ${lit(i.name)})
  .add(zyndTrigger)
  .to(requestStep.to(aiStep.to(answerStep)))
  .add(chatTrigger)
  .to(requestStep);`);
  return out.join('\n');
}

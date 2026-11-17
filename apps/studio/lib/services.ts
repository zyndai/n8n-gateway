import 'server-only';
import { AgentService, type AgentServiceDeps } from './agents/service';
import { createTreasury } from './credit/starter';
import { builderConfigured, builderEnv, creditEnv, studioEnv } from './env';
import { createGatewayClient } from './gateway/client';
import { N8nMcp } from './n8n/mcp';
import { restWorkflowWriter } from './n8n/rest';
import { OpenAIClient } from './openai';
import { Registry } from './registry';
import type { StudioSession } from './session-cookie';

/** Process-wide pieces: they keep a session or a cache, so they are built once. */
interface Shared {
  mcp: N8nMcp;
  registry: Registry;
  openai: OpenAIClient;
  deps: Omit<AgentServiceDeps, 'gateway'>;
  gateway: ReturnType<typeof createGatewayClient>;
  builderModel: string;
  agentModel: string;
  sessionSecret: string;
  /** The name of the platform's OpenAI credential in n8n, looked up once. */
  openAiCredentialName(): Promise<string>;
}

let shared: Shared | undefined;

const CREDENTIAL_TTL_MS = 5 * 60_000;

export { builderConfigured };

function build(): Shared {
  const env = studioEnv();
  const b = builderEnv();
  const credit = creditEnv();
  const mcp = new N8nMcp({ url: env.n8nMcpUrl, token: env.n8nMcpToken });
  const gateway = createGatewayClient({ baseUrl: env.gatewayUrl, sessionSecret: env.sessionJwtSecret, serviceToken: env.serviceToken });

  const cache = new Map<string, { at: number; value: string | undefined }>();
  const cached = async (key: string, load: () => Promise<string | undefined>): Promise<string | undefined> => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CREDENTIAL_TTL_MS && hit.value !== undefined) return hit.value;
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  };

  const openAiCredentialName = async (): Promise<string> => {
    const name = await cached(`openai-name|${b.openAiCredentialId}`, async () => {
      const out = (await mcp.callTool('list_credentials', { type: 'openAiApi', limit: 50 })) as { data?: { id: string; name: string }[] } | null;
      return out?.data?.find((c) => c.id === b.openAiCredentialId)?.name;
    });
    if (!name) throw new Error('The platform OpenAI credential was not found in n8n');
    return name;
  };

  const registry = new Registry({ agentDnsUrl: b.agentDnsUrl, maxCallPriceUsd: b.maxCallPriceUsd });
  const deps: Shared['deps'] = {
    mcp,
    workflows: restWorkflowWriter({ apiUrl: env.n8nApiUrl, apiKey: env.n8nApiKey }),
    findCredentialId: (type, name) =>
      cached(`${type}|${name}`, async () => {
        const found = await mcp.findCredentials(type, name);
        return found.length === 1 ? found[0]?.id : undefined;
      }),
    treasury: credit ? createTreasury(credit) : null,
    starterCreditUsd: credit?.amountUsd ?? '0',
    starterCreditMaxAgents: credit?.maxAgents ?? 0,
    openAiCredentialId: b.openAiCredentialId,
    openAiCredentialName,
    agentModel: b.agentModel,
    dataSources: b.dataSources,
    maxCallPriceUsd: b.maxCallPriceUsd,
    log: console,
  };
  return {
    mcp,
    registry,
    openai: new OpenAIClient({ apiKey: b.openAiApiKey }),
    deps,
    gateway,
    builderModel: b.openAiModel,
    agentModel: b.agentModel,
    sessionSecret: env.sessionJwtSecret,
    openAiCredentialName,
  };
}

export function services(): Shared {
  shared ??= build();
  return shared;
}

/** The agent service for one signed-in person. */
export function agentsFor(session: StudioSession): AgentService {
  const s = services();
  return new AgentService({ ...s.deps, gateway: s.gateway }, session);
}

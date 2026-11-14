type Env = Record<string, string | undefined>;

// Server-side settings. Read lazily (never at import), so `next build` needs none of them, and a missing
// one names itself without ever printing a value.

/** Preview mode: every page shows sample data and nobody signs in. For the look sign-off and local work only. */
export function isPreview(env: Env = process.env): boolean {
  return ['1', 'true', 'yes', 'on'].includes((env.STUDIO_PREVIEW ?? '').toLowerCase());
}

export class ConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(`Studio is not configured: set ${missing.join(', ')}`);
    this.name = 'ConfigError';
  }
}

export interface StudioEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  gatewayUrl: string;
  /** The Gateway address n8n should put in the credential. Defaults to `gatewayUrl`. */
  gatewayUrlForN8n: string;
  sessionJwtSecret: string;
  serviceToken: string;
  n8nApiUrl: string;
  n8nApiKey: string;
  n8nMcpUrl: string;
  n8nMcpToken: string;
  agentKeySpendCapUsd: string;
}

const need = (env: Env, names: string[]): void => {
  const missing = names.filter((n) => !env[n]?.trim());
  if (missing.length) throw new ConfigError(missing);
};
const trimSlash = (s: string) => s.trim().replace(/\/+$/, '');

/** Everything the sign-in and silent setup need. */
export function studioEnv(env: Env = process.env): StudioEnv {
  need(env, [
    'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'GATEWAY_URL', 'SESSION_JWT_SECRET', 'STUDIO_SERVICE_TOKEN',
    'N8N_API_URL', 'N8N_API_KEY', 'N8N_MCP_URL', 'N8N_MCP_TOKEN',
  ]);
  const gatewayUrl = trimSlash(env.GATEWAY_URL as string);
  return {
    supabaseUrl: trimSlash(env.NEXT_PUBLIC_SUPABASE_URL as string),
    supabaseAnonKey: (env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string).trim(),
    gatewayUrl,
    gatewayUrlForN8n: env.N8N_GATEWAY_URL?.trim() ? trimSlash(env.N8N_GATEWAY_URL) : gatewayUrl,
    sessionJwtSecret: env.SESSION_JWT_SECRET as string,
    serviceToken: env.STUDIO_SERVICE_TOKEN as string,
    n8nApiUrl: trimSlash(env.N8N_API_URL as string),
    n8nApiKey: env.N8N_API_KEY as string,
    n8nMcpUrl: trimSlash(env.N8N_MCP_URL as string),
    n8nMcpToken: env.N8N_MCP_TOKEN as string,
    agentKeySpendCapUsd: env.AGENT_KEY_SPEND_CAP_USD?.trim() || '5',
  };
}

/** A data source (one AirnodeHub operation) the builder may give an agent. Listed by the owner in `AIRNODE_SOURCES`. */
export interface DataSource {
  name: string;
  /** The AirnodeHub listing root, https. */
  listingUrl: string;
  operation: string;
  /** What it returns, in a sentence: the AI reads this. */
  what: string;
  /** The most one call may cost, USD. */
  maxPriceUsd: string;
  /** The parameters the AI fills, e.g. `lei`. */
  fields?: string;
}

const USD_RE = /^\d{1,4}(\.\d{1,6})?$/;

/** `AIRNODE_SOURCES` is a JSON array of DataSource. Entries that are not well formed are dropped, never guessed. */
export function parseDataSources(raw: string | undefined): DataSource[] {
  if (!raw?.trim()) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: DataSource[] = [];
  for (const e of list as Record<string, unknown>[]) {
    const s = (k: string) => (typeof e?.[k] === 'string' ? (e[k] as string).trim() : '');
    const price = s('maxPriceUsd') || '0.05';
    let url: URL | null = null;
    try {
      url = new URL(s('listingUrl'));
    } catch {
      /* dropped below */
    }
    if (!s('name') || !s('operation') || !s('what') || !url || url.protocol !== 'https:' || !USD_RE.test(price)) continue;
    out.push({ name: s('name'), listingUrl: `${url.origin}/`, operation: s('operation'), what: s('what'), maxPriceUsd: price, ...(s('fields') ? { fields: s('fields') } : {}) });
  }
  return out;
}

export interface BuilderEnv {
  openAiApiKey: string;
  /** The model that drives the builder chat. */
  openAiModel: string;
  /** The model every agent runs on inside n8n. */
  agentModel: string;
  /** The platform's OpenAI credential in n8n (id), the only one an agent may use. */
  openAiCredentialId: string;
  /** The registry, searched directly for helpers (no key needed). */
  agentDnsUrl: string;
  dataSources: DataSource[];
  /** The most any one helper or data-source call may cost, USD. */
  maxCallPriceUsd: string;
}

/** Everything the agent builder needs on top of {@link studioEnv}. A missing value names itself. */
export function builderEnv(env: Env = process.env): BuilderEnv {
  need(env, ['OPENAI_API_KEY', 'OPENAI_MODEL', 'N8N_OPENAI_CREDENTIAL_ID']);
  return {
    openAiApiKey: env.OPENAI_API_KEY as string,
    openAiModel: (env.OPENAI_MODEL as string).trim(),
    agentModel: env.AGENT_MODEL?.trim() || 'gpt-5-mini',
    openAiCredentialId: (env.N8N_OPENAI_CREDENTIAL_ID as string).trim(),
    agentDnsUrl: trimSlash(env.AGENTDNS_URL?.trim() || 'https://zns01.zynd.ai'),
    dataSources: parseDataSources(env.AIRNODE_SOURCES),
    maxCallPriceUsd: env.AGENT_MAX_CALL_USD?.trim() || '0.25',
  };
}

/** True when the builder is switched on (the three secrets are there). Never throws. */
export function builderConfigured(env: Env = process.env): boolean {
  try {
    builderEnv(env);
    studioEnv(env);
    return true;
  } catch {
    return false;
  }
}

export interface CreditEnv {
  /** Private key of the platform wallet that sends the starter credit. */
  treasuryKey: string;
  rpcUrl: string;
  chainId: number;
  /** The token agents pay in (aUSD on Base Sepolia). */
  asset: string;
  decimals: number;
  amountUsd: string;
  /** Only a user's first N agents get starter credit. */
  maxAgents: number;
}

/** Starter credit settings, or null when no platform wallet is configured (agents are then created without credit). */
export function creditEnv(env: Env = process.env): CreditEnv | null {
  const key = env.TREASURY_PRIVATE_KEY?.trim();
  if (!key) return null;
  return {
    treasuryKey: key,
    rpcUrl: trimSlash(env.X402_RPC_URL?.trim() || 'https://sepolia.base.org'),
    chainId: Number(env.STARTER_CREDIT_CHAIN_ID ?? 84532),
    asset: env.STARTER_CREDIT_ASSET?.trim() || '0xbeA34973e5f67F18F656A2C6070C64326C791808',
    decimals: Number(env.STARTER_CREDIT_DECIMALS ?? 6),
    amountUsd: env.STARTER_CREDIT_USD?.trim() || '1',
    maxAgents: Number(env.STARTER_CREDIT_MAX_AGENTS ?? 3),
  };
}

/** Just what the page shell needs (the session check): Supabase and the cookie secret. */
export function sessionEnv(env: Env = process.env): { supabaseUrl: string; supabaseAnonKey: string; sessionJwtSecret: string } {
  need(env, ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SESSION_JWT_SECRET']);
  return {
    supabaseUrl: trimSlash(env.NEXT_PUBLIC_SUPABASE_URL as string),
    supabaseAnonKey: (env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string).trim(),
    sessionJwtSecret: env.SESSION_JWT_SECRET as string,
  };
}

// n8n's REST API (public API v1). The MCP server cannot create credentials, so Studio does that here. Since S5,
// Studio also writes agents' workflows here: REST stores credentials exactly as given and can change a live agent's
// draft without putting it live (`publishIfActive=false`), which MCP's create-from-code cannot promise. Runs still go
// through MCP, since REST cannot run a draft with a chat message (docs/STUDIO_PLAN.md, "n8n findings for S5").
export class N8nError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'N8nError';
  }
}

export interface CreatedCredential {
  id: string;
  name: string;
  type: string;
}

export interface N8nRestConfig {
  apiUrl: string;
  apiKey: string;
}

/** One REST call. n8n's error message can name a field but never echoes secrets; only its first line is kept. */
async function call(cfg: N8nRestConfig, method: string, path: string, body: unknown, fetchImpl: typeof fetch, timeoutMs = 20_000): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.apiUrl.replace(/\/+$/, '')}/api/v1${path}`, {
      method,
      headers: { 'X-N8N-API-KEY': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new N8nError('n8n could not be reached', 502);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = `n8n answered ${res.status}`;
    try {
      const m = (JSON.parse(text) as { message?: unknown }).message;
      if (typeof m === 'string') message = m.split('\n')[0]?.slice(0, 200) ?? message;
    } catch {
      /* not JSON */
    }
    throw new N8nError(message, res.status);
  }
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    throw new N8nError('n8n sent a reply that is not JSON', 502);
  }
}

/** POST /api/v1/credentials. `data` holds the secrets; they are sent once and never read back. */
export async function createCredential(
  cfg: N8nRestConfig,
  body: { name: string; type: string; data: Record<string, string> },
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedCredential> {
  const out = (await call(cfg, 'POST', '/credentials', body, fetchImpl)) as Partial<CreatedCredential> | null;
  if (!out?.id) throw new N8nError('n8n did not return the new credential', 502);
  return { id: String(out.id), name: String(out.name ?? body.name), type: String(out.type ?? body.type) };
}

/** What Studio sends for a workflow: nothing n8n treats as read-only (id, active, tags, version ids). */
export interface WorkflowWrite {
  name: string;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
}

/** Where agents' workflows are written. The relay checks everything before and after. */
export interface WorkflowWriter {
  /** Creates a draft (not live) and returns its id. */
  create(body: WorkflowWrite): Promise<string>;
  /** Replaces a workflow's steps. A live one keeps running its published version until it is published again. */
  replace(id: string, body: WorkflowWrite): Promise<void>;
}

export function restWorkflowWriter(cfg: N8nRestConfig, fetchImpl: typeof fetch = fetch): WorkflowWriter {
  const clean = (b: WorkflowWrite): WorkflowWrite => ({ name: b.name.slice(0, 128), nodes: b.nodes, connections: b.connections, settings: b.settings });
  return {
    async create(body) {
      const out = (await call(cfg, 'POST', '/workflows', clean(body), fetchImpl)) as { id?: unknown } | null;
      if (typeof out?.id !== 'string' || !out.id) throw new N8nError('n8n did not return the new workflow', 502);
      return out.id;
    },
    async replace(id, body) {
      if (!/^[A-Za-z0-9]{1,64}$/.test(id)) throw new N8nError('Not a workflow id', 400);
      await call(cfg, 'PUT', `/workflows/${id}?publishIfActive=false`, clean(body), fetchImpl);
    },
  };
}

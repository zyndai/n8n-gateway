// n8n's REST API (public API v1). The MCP server cannot create credentials, so Studio does it here.
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

/** POST /api/v1/credentials. `data` holds the secrets; they are sent once and never read back. */
export async function createCredential(
  cfg: N8nRestConfig,
  body: { name: string; type: string; data: Record<string, string> },
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedCredential> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.apiUrl.replace(/\/+$/, '')}/api/v1/credentials`, {
      method: 'POST',
      headers: { 'X-N8N-API-KEY': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new N8nError('n8n could not be reached', 502);
  }
  const text = await res.text();
  if (!res.ok) {
    // n8n's message can name a field; it never echoes the secrets. Keep only the first line.
    let message = `n8n answered ${res.status}`;
    try {
      const m = (JSON.parse(text) as { message?: unknown }).message;
      if (typeof m === 'string') message = m.split('\n')[0]?.slice(0, 200) ?? message;
    } catch {
      /* not JSON */
    }
    throw new N8nError(message, res.status);
  }
  const out = JSON.parse(text) as Partial<CreatedCredential>;
  if (!out.id) throw new N8nError('n8n did not return the new credential', 502);
  return { id: String(out.id), name: String(out.name ?? body.name), type: String(out.type ?? body.type) };
}

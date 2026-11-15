// A small client for n8n's MCP server (Streamable HTTP, JSON-RPC 2.0). Studio uses it from the server only; the
// token stays here. The reply can be plain JSON or a one-message event stream, so both are read.
export class McpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'McpError';
  }
}

export interface McpConfig {
  url: string;
  token: string;
}

interface RpcReply {
  result?: { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  error?: { message?: string };
}

/** The JSON-RPC message for `id` out of a JSON body or a `text/event-stream` body. */
export function parseRpcBody(contentType: string, text: string, id: number): RpcReply {
  if (contentType.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as RpcReply & { id?: number };
        if (msg.id === id) return msg;
      } catch {
        /* skip a non-JSON event */
      }
    }
    throw new McpError('n8n MCP sent no reply');
  }
  try {
    return JSON.parse(text) as RpcReply;
  } catch {
    throw new McpError('n8n MCP sent a reply that is not JSON');
  }
}

export class N8nMcp {
  private nextId = 1;
  private session: Promise<string | undefined> | undefined;

  constructor(
    private readonly cfg: McpConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async post(body: unknown, sessionId?: string): Promise<Response> {
    try {
      return await this.fetchImpl(this.cfg.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new McpError('n8n MCP could not be reached', 502);
    }
  }

  /** initialize + notifications/initialized, once. Resolves to the session id when the server uses one. */
  private open(): Promise<string | undefined> {
    this.session ??= (async () => {
      const id = this.nextId++;
      const res = await this.post({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'zynd-studio', version: '0.1.0' } } });
      const text = await res.text();
      if (!res.ok) throw new McpError(`n8n MCP answered ${res.status}`, res.status);
      const reply = parseRpcBody(res.headers.get('content-type') ?? '', text, id);
      if (reply.error) throw new McpError(reply.error.message ?? 'n8n MCP refused to start');
      const sessionId = res.headers.get('mcp-session-id') ?? undefined;
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId).then((r) => r.text()).catch(() => undefined);
      return sessionId;
    })();
    this.session.catch(() => (this.session = undefined));
    return this.session;
  }

  /**
   * Call one MCP tool. Returns its structured result, or the JSON its text content holds. A session n8n no longer
   * knows (it restarted) is opened again once.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return await this.callOnce(name, args);
    } catch (err) {
      if (!(err instanceof McpError) || (err.status !== 404 && err.status !== 400) || !(await this.session)) throw err;
      this.session = undefined;
      return this.callOnce(name, args);
    }
  }

  private async callOnce(name: string, args: Record<string, unknown>): Promise<unknown> {
    const sessionId = await this.open();
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, sessionId);
    const text = await res.text();
    if (!res.ok) throw new McpError(`n8n MCP answered ${res.status}`, res.status);
    const reply = parseRpcBody(res.headers.get('content-type') ?? '', text, id);
    if (reply.error) throw new McpError(reply.error.message ?? 'n8n MCP call failed');
    const out = reply.result;
    const body = out?.content?.find((c) => c.type === 'text')?.text ?? '';
    if (out?.isError) throw new McpError(body.slice(0, 200) || 'n8n MCP tool failed');
    if (out?.structuredContent !== undefined) return out.structuredContent;
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  /** Credentials of one type whose name matches `name` exactly. */
  async findCredentials(type: string, name: string): Promise<{ id: string; name: string; type: string }[]> {
    const out = (await this.callTool('list_credentials', { type, query: name, limit: 50 })) as { data?: { id: string; name: string; type: string }[] } | null;
    return (out?.data ?? []).filter((c) => c.type === type && c.name === name);
  }
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpError, N8nMcp, parseRpcBody } from '@/lib/n8n/mcp';
import { N8nError, createCredential } from '@/lib/n8n/rest';

interface Rpc {
  id?: number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

/** A stand-in for n8n's MCP server: `sse` answers as an event stream, `sessions` hands out a session id. */
class FakeMcp {
  server: Server;
  url = '';
  seen: { method: string; auth: string | undefined; session: string | undefined; tool?: string; args?: Record<string, unknown> }[] = [];
  sse = false;
  sessions = false;
  /** Answer the next `initialize` with a 503, once. */
  failInit = false;
  /** The session the server currently knows; a request carrying another one gets a 404 (as after an n8n restart). */
  current = 'sess-1';
  /** Answer every tool call with this status, when set. */
  toolStatus: number | undefined;
  credentials = [
    { id: 'c1', name: 'Zynd · ada-x7k2', type: 'zyndApi' },
    { id: 'c2', name: 'Zynd · ada-x7k2 copy', type: 'zyndApi' },
    { id: 'c3', name: 'Zynd · ada-x7k2', type: 'openAiApi' },
  ];
  toolResult: ((rpc: Rpc) => Record<string, unknown>) | undefined;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }
  async listen() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/mcp-server/http`;
  }
  async close() {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Rpc;
    const session = req.headers['mcp-session-id'] as string | undefined;
    this.seen.push({ method: rpc.method, auth: req.headers.authorization, session, ...(rpc.params?.name ? { tool: rpc.params.name, args: rpc.params.arguments ?? {} } : {}) });
    if (req.headers.authorization !== 'Bearer good-token') {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (rpc.method === 'initialize' && this.failInit) {
      this.failInit = false;
      res.writeHead(503).end('starting up');
      return;
    }
    if (this.sessions && rpc.method !== 'initialize' && session && session !== this.current) {
      res.writeHead(404).end('session not found');
      return;
    }
    if (this.toolStatus && rpc.method === 'tools/call') {
      res.writeHead(this.toolStatus).end('nope');
      return;
    }
    if (rpc.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '1' } };
    else if (this.toolResult) result = this.toolResult(rpc);
    else {
      const q = String(rpc.params?.arguments?.query ?? '');
      const data = this.credentials.filter((c) => c.name.includes(q));
      result = { content: [{ type: 'text', text: JSON.stringify({ data, count: data.length }) }] };
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
    const headers: Record<string, string> = this.sessions && rpc.method === 'initialize' ? { 'Mcp-Session-Id': this.current } : {};
    if (this.sse) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
      res.end(`event: message\ndata: ${body}\n\n`);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
      res.end(body);
    }
  }
}

describe('N8nMcp', () => {
  let fake: FakeMcp;
  beforeEach(async () => {
    fake = new FakeMcp();
    await fake.listen();
  });
  afterEach(() => fake.close());

  it('lists credentials of one type by exact name, over a JSON reply', async () => {
    const mcp = new N8nMcp({ url: fake.url, token: 'good-token' });
    expect(await mcp.findCredentials('zyndApi', 'Zynd · ada-x7k2')).toEqual([{ id: 'c1', name: 'Zynd · ada-x7k2', type: 'zyndApi' }]);
    expect(await mcp.findCredentials('zyndApi', 'Zynd · nobody')).toEqual([]);
  });

  it('reads an event-stream reply the same way', async () => {
    fake.sse = true;
    const mcp = new N8nMcp({ url: fake.url, token: 'good-token' });
    expect(await mcp.findCredentials('zyndApi', 'Zynd · ada-x7k2')).toHaveLength(1);
  });

  it('starts the session once, sends the token every time, and passes a session id along', async () => {
    fake.sessions = true;
    const mcp = new N8nMcp({ url: fake.url, token: 'good-token' });
    await mcp.findCredentials('zyndApi', 'a');
    await mcp.findCredentials('zyndApi', 'b');
    expect(fake.seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
    expect(fake.seen.every((s) => s.auth === 'Bearer good-token')).toBe(true);
    expect(fake.seen.slice(1).every((s) => s.session === 'sess-1')).toBe(true);
    expect(fake.seen[2]).toMatchObject({ tool: 'list_credentials', args: { type: 'zyndApi', query: 'a', limit: 50 } });
  });

  it('prefers structuredContent and falls back to plain text', async () => {
    const mcp = new N8nMcp({ url: fake.url, token: 'good-token' });
    fake.toolResult = () => ({ structuredContent: { ok: 1 }, content: [{ type: 'text', text: 'ignored' }] });
    expect(await mcp.callTool('x')).toEqual({ ok: 1 });
    fake.toolResult = () => ({ content: [{ type: 'text', text: 'just words' }] });
    expect(await mcp.callTool('x')).toBe('just words');
  });

  it('turns a tool failure into an McpError that carries n8n\'s message', async () => {
    const mcp = new N8nMcp({ url: fake.url, token: 'good-token' });
    fake.toolResult = () => ({ isError: true, content: [{ type: 'text', text: 'Workflow not found' }] });
    await expect(mcp.callTool('get_workflow_details', { workflowId: 'x' })).rejects.toThrow('Workflow not found');
  });

  it('refuses a bad token and a dead server with McpError, never a raw fetch error', async () => {
    await expect(new N8nMcp({ url: fake.url, token: 'wrong' }).findCredentials('zyndApi', 'x')).rejects.toBeInstanceOf(McpError);
    await expect(new N8nMcp({ url: 'http://127.0.0.1:1/mcp', token: 'good-token' }).callTool('x')).rejects.toMatchObject({ status: 502 });
  });

  it('opens a new session once when n8n has forgotten the old one (it restarted)', async () => {
    fake.sessions = true;
    const mcp = new N8nMcp({ url: fake.url, token: 'good-token' });
    expect(await mcp.findCredentials('zyndApi', 'Zynd · ada-x7k2')).toHaveLength(1);
    fake.current = 'sess-2';
    expect(await mcp.findCredentials('zyndApi', 'Zynd · ada-x7k2')).toHaveLength(1);
    expect(fake.seen.filter((x) => x.method === 'initialize')).toHaveLength(2);
    expect(fake.seen.at(-1)?.session).toBe('sess-2');
  });

  it('does not start over on a 404 when the server uses no sessions: that is a real answer', async () => {
    const mcp = new N8nMcp({ url: fake.url, token: 'good-token' });
    fake.toolStatus = 404;
    await expect(mcp.callTool('get_workflow_details', { workflowId: 'x' })).rejects.toMatchObject({ status: 404 });
    expect(fake.seen.filter((x) => x.method === 'initialize')).toHaveLength(1);
    expect(fake.seen.filter((x) => x.method === 'tools/call')).toHaveLength(1);
  });

  it('can retry after a failed start', async () => {
    const mcp = new N8nMcp({ url: fake.url, token: 'good-token' });
    fake.failInit = true;
    await expect(mcp.findCredentials('zyndApi', 'x')).rejects.toBeInstanceOf(McpError);
    // The same client: the failed start is not remembered, the next call starts again.
    expect(await mcp.findCredentials('zyndApi', 'Zynd · ada-x7k2')).toHaveLength(1);
  });
});

describe('parseRpcBody', () => {
  it('picks the message with the right id out of an event stream and skips noise', () => {
    const text = ': keep-alive\n\nevent: message\ndata: not json\n\nevent: message\ndata: {"jsonrpc":"2.0","id":9,"result":{"a":1}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"a":2}}\n\n';
    expect(parseRpcBody('text/event-stream; charset=utf-8', text, 2)).toMatchObject({ result: { a: 2 } });
  });
  it('throws McpError when there is no reply', () => {
    expect(() => parseRpcBody('text/event-stream', 'event: ping\n\n', 1)).toThrow(McpError);
    expect(() => parseRpcBody('application/json', '<html>', 1)).toThrow(McpError);
  });
});

describe('createCredential (n8n REST)', () => {
  const cfg = { apiUrl: 'https://n8n.example.com/', apiKey: 'n8n-api-key' };
  const body = { name: 'Zynd · ada-x7k2', type: 'zyndApi', data: { apiUrl: 'http://gateway:8080', apiKey: 'zk_secret', webhookSecret: 'ws' } };

  it('posts to the public API with the API key and returns the new id', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: 'cred-9', name: body.name, type: body.type, createdAt: 'now' }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await createCredential(cfg, body, fetchImpl)).toEqual({ id: 'cred-9', name: body.name, type: 'zyndApi' });
    expect(seen?.url).toBe('https://n8n.example.com/api/v1/credentials');
    expect((seen?.init.headers as Record<string, string>)['X-N8N-API-KEY']).toBe('n8n-api-key');
    expect(JSON.parse(seen?.init.body as string)).toEqual(body);
  });

  it('keeps n8n\'s message to one short line and never echoes the secrets', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'request.body.data is invalid\nmore detail zk_secret' }), { status: 400 })) as unknown as typeof fetch;
    const err = (await createCredential(cfg, body, fetchImpl).catch((e: unknown) => e)) as N8nError;
    expect(err).toBeInstanceOf(N8nError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('request.body.data is invalid');
    expect(err.message).not.toContain('zk_secret');
  });

  it('answers N8nError 502 when n8n is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(createCredential(cfg, body, fetchImpl)).rejects.toMatchObject({ status: 502 });
  });
});

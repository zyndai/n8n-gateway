import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebhookForwarder, type ForwardPayload } from '../src/services/WebhookForwarder.js';

const payload: ForwardPayload = { jobId: 'job-1', listingId: 'l1', entityId: 'zns:1', caller: 'zns:2', input: { a: 1 }, message: { parts: [] }, createdAt: '2026-01-01T00:00:00.000Z' };
const fast = { retryDelayMs: 20, connectTimeoutMs: 300, responseTimeoutMs: 300 };

interface Seen {
  headers: IncomingMessage['headers'];
  body: string;
}
let server: Server | undefined;
let seen: Seen[];

async function serve(handler: (req: IncomingMessage, res: ServerResponse, n: number) => void): Promise<string> {
  seen = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body });
      handler(req, res, seen.length);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook/abc`;
}
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
});

const reply = (res: ServerResponse, status: number, body?: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

describe('WebhookForwarder (M2.8)', () => {
  it('POSTs the job with the secret and job-id headers and returns the JSON body', async () => {
    const url = await serve((_q, res) => reply(res, 200, { output: { ok: true } }));
    const res = await new WebhookForwarder(fast).forward(url, 'sekret-123', payload);
    expect(res).toEqual({ status: 200, body: { output: { ok: true } } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers['x-zynd-webhook-secret']).toBe('sekret-123');
    expect(seen[0]!.headers['x-zynd-job-id']).toBe('job-1');
    expect(seen[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen[0]!.body)).toEqual(payload);
  });

  it('accepts an empty or non-JSON 2xx body', async () => {
    const url = await serve((_q, res) => res.writeHead(200).end('Workflow was started'));
    expect(await new WebhookForwarder(fast).forward(url, 's', payload)).toEqual({ status: 200, body: undefined });
  });

  it('retries once after a 5xx and succeeds', async () => {
    const url = await serve((_q, res, n) => (n === 1 ? reply(res, 502) : reply(res, 200, {})));
    const t0 = Date.now();
    const res = await new WebhookForwarder({ ...fast, retryDelayMs: 80 }).forward(url, 's', payload);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(75); // waited the retry delay
  });

  it('gives up after the second 5xx with GATEWAY_UNAVAILABLE', async () => {
    const url = await serve((_q, res) => reply(res, 503));
    await expect(new WebhookForwarder(fast).forward(url, 's', payload)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE', status: 502 });
    expect(seen).toHaveLength(2);
  });

  it('does not retry a 4xx (e.g. wrong secret)', async () => {
    const url = await serve((_q, res) => reply(res, 403));
    await expect(new WebhookForwarder(fast).forward(url, 's', payload)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE', details: { status: 403 } });
    expect(seen).toHaveLength(1);
  });

  it('retries a refused connection, then fails', async () => {
    const url = await serve((_q, res) => reply(res, 200));
    const dead = url.replace(/:\d+/, ':1'); // nothing listens on port 1
    await expect(new WebhookForwarder(fast).forward(dead, 's', payload)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
  });

  it('times out a slow response and does NOT retry it (the job may already be running)', async () => {
    const url = await serve(() => {
      /* never answers */
    });
    await expect(new WebhookForwarder({ ...fast, responseTimeoutMs: 120 }).forward(url, 's', payload)).rejects.toMatchObject({
      code: 'GATEWAY_UNAVAILABLE',
      message: expect.stringMatching(/did not respond/),
    });
    expect(seen).toHaveLength(1);
  });

  it('times out connecting to an unroutable address', async () => {
    // 10.255.255.1 black-holes SYNs on most networks; where it is rejected immediately the same retry path applies.
    const started = Date.now();
    await expect(new WebhookForwarder({ ...fast, connectTimeoutMs: 100, retryDelayMs: 10 }).forward('http://10.255.255.1:81/x', 's', payload)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects invalid and non-http URLs', async () => {
    const f = new WebhookForwarder(fast);
    await expect(f.forward('not a url', 's', payload)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
    await expect(f.forward('ftp://example.com/x', 's', payload)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
  });

  it('does not follow redirects (a redirect is a rejection, never a secret leak)', async () => {
    const url = await serve((_q, res) => res.writeHead(302, { Location: 'http://127.0.0.1:1/' }).end());
    await expect(new WebhookForwarder(fast).forward(url, 's', payload)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE', details: { status: 302 } });
    expect(seen).toHaveLength(1);
  });
});

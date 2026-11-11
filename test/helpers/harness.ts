// Wires the real services (ListingService, A2AHandler, AgentCaller, PaymentProcessor,
// WebhookForwarder, routes, middleware) onto in-memory stores, a fake AgentDNS, a fake n8n
// webhook receiver and a fake x402 facilitator, all over real HTTP. Nothing is mocked in the path.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { A2AHandler } from '../../src/services/A2AHandler.js';
import { AgentCardService } from '../../src/services/AgentCard.js';
import { AgentCaller } from '../../src/services/AgentCaller.js';
import { AgentDnsClient } from '../../src/services/AgentDnsClient.js';
import { AirnodeClient, DEFAULT_AIRNODE_CONFIG } from '../../src/services/AirnodeClient.js';
import { IdentityService, keypairFromSeed, publicKeyString, type Ed25519Keypair } from '../../src/services/IdentityService.js';
import { ListingService, type ListingView } from '../../src/services/ListingService.js';
import type { ListingStoreLike } from '../../src/services/ListingStore.js';
import type { ApiKeyStoreLike } from '../../src/services/ApiKeyStore.js';
import type { NonceStoreLike } from '../../src/services/NonceStore.js';
import type { TaskStoreLike } from '../../src/services/TaskStore.js';
import { PaymentProcessor } from '../../src/services/PaymentProcessor.js';
import { RateLimiter, type RateLimiterOptions } from '../../src/services/RateLimiter.js';
import { PaymentProofVault } from '../../src/services/PaymentRecovery.js';
import { WebhookForwarder, type ForwardPayload } from '../../src/services/WebhookForwarder.js';
import { encryptSecret, parseMasterKey } from '../../src/services/keyVault.js';
import { signZyndAuth, type A2AMessage } from '../../src/services/zyndAuth.js';
import { FakeAgentDns } from './fakeAgentDns.js';
import { MemoryApiKeys, MemoryNonces, MemoryTasks } from './memoryStores.js';
import { MemoryStore } from './memoryStore.js';

export const DEV = 'zns:dev:harness';
export const API_KEY = 'zk_live_harness_key_0001';
export const WEBHOOK_SECRET = 'webhook-secret-123';
export const masterKey = parseMasterKey('ab'.repeat(32));
export const devSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const silent = { info: () => {}, warn: () => {}, error: () => {} };

export interface Job {
  payload: ForwardPayload;
  headers: IncomingMessage['headers'];
}

export interface HarnessOptions {
  /** Inbound price in USD; unset = free. */
  price?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Serve the app on a real loopback port and use that as the Gateway's public URL (for clients that make real requests, e.g. the SDK). */
  listen?: boolean;
  /** Per-key rate limit on /n8n/v1/*; unset = unlimited. */
  rateLimit?: RateLimiterOptions;
  /** Delay added to each fake facilitator call (verify, settle), to model a real network hop. */
  facilitatorDelayMs?: number;
  /** Overall deadline for outbound calls. */
  callerTimeoutMs?: number;
  /** Swap in the Postgres-backed stores (the API key must already exist in them). */
  /** Swap in the Postgres listing store (the developer key row must hold the harness seed). */
  listingStore?: ListingStoreLike;
  stores?: { tasks?: TaskStoreLike; apiKeys?: ApiKeyStoreLike; nonces?: NonceStoreLike };
  /** Fake AirnodeHub: the fetch AirnodeClient uses. Unset = /n8n/v1/airnode/* answers 501. */
  airnodeFetch?: typeof fetch;
}

export async function makeGateway(opts: HarnessOptions = {}) {
  // With `listen`, the public URL has to be known before the services are built, so the server
  // starts first and hands requests to the app once it exists.
  const front: { handler?: (req: IncomingMessage, res: ServerResponse) => void } = {};
  const gwServer: Server | undefined = opts.listen ? createServer((req, res) => (front.handler ? front.handler(req, res) : void res.writeHead(503).end())) : undefined;
  if (gwServer) await new Promise<void>((r) => gwServer.listen(0, '127.0.0.1', r));
  const publicUrl = gwServer ? `http://127.0.0.1:${(gwServer.address() as AddressInfo).port}` : 'https://gw.test';

  const dns = new FakeAgentDns();
  await dns.listen();
  dns.developers.set(DEV, publicKeyString(keypairFromSeed(devSeed).publicKey));

  const store = (opts.listingStore ?? new MemoryStore()) as MemoryStore;
  if (!opts.listingStore) store.keys.set(DEV, { privateKeyEnc: encryptSecret(Buffer.from(devSeed).toString('base64'), masterKey), publicKey: '' });
  const identity = new IdentityService({ masterKey, keySource: store });
  const agentDns = new AgentDnsClient(dns.url);
  const beats = { started: [] as string[], stopped: [] as string[] };
  const listings = new ListingService({
    store,
    identity,
    agentDns,
    heartbeats: { start: (a) => void beats.started.push(a.entityId), stop: async (id) => void beats.stopped.push(id) },
    publicUrl,
    heartbeatRequiresWebhook: true,
    masterKey,
    allowPrivateWebhooks: true,
    log: silent,
  });

  // fake n8n
  const jobs: Job[] = [];
  const n8n = { respond: ((_job: Job, res: ServerResponse) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"message":"Workflow was started"}')) as (job: Job, res: ServerResponse) => void };
  const n8nServer: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const job: Job = { payload: JSON.parse(body) as ForwardPayload, headers: req.headers };
      jobs.push(job);
      n8n.respond(job, res);
    });
  });
  await new Promise<void>((r) => n8nServer.listen(0, '127.0.0.1', r));
  const webhookUrl = `http://127.0.0.1:${(n8nServer.address() as AddressInfo).port}/webhook/zynd`;

  // fake facilitator
  const fac = { verify: { isValid: true } as Record<string, unknown>, settle: { success: true, transaction: '0xsettled' } as Record<string, unknown>, calls: [] as string[] };
  const x402 = { ...loadConfig({}).x402, inboundPriceUsd: opts.price };
  const payments = new PaymentProcessor({
    config: x402,
    fetch: (async (url: string) => {
      const op = url.endsWith('/verify') ? 'verify' : 'settle';
      fac.calls.push(op);
      if (opts.facilitatorDelayMs) await new Promise((r) => setTimeout(r, opts.facilitatorDelayMs));
      return Response.json(fac[op]);
    }) as unknown as typeof fetch,
  });

  const tasks = (opts.stores?.tasks ?? new MemoryTasks()) as MemoryTasks;
  const apiKeys = (opts.stores?.apiKeys ?? new MemoryApiKeys()) as MemoryApiKeys;
  const nonces = opts.stores?.nonces ?? new MemoryNonces();
  const keyRow = opts.stores?.apiKeys ? (undefined as never) : apiKeys.add(API_KEY, { developerId: DEV });
  const a2a = new A2AHandler({
    listings,
    tasks,
    payments,
    vault: new PaymentProofVault(masterKey),
    identity,
    forwarder: new WebhookForwarder({ connectTimeoutMs: 500, responseTimeoutMs: 1000, retryDelayMs: 10 }),
    inboundPriceUsd: opts.price,
    publicUrl,
    timeoutMs: opts.timeoutMs,
    pollIntervalMs: opts.pollIntervalMs,
  });
  const caller = new AgentCaller({ agentDns, identity, store, payments, tasks, apiKeys, defaultMaxPaymentUsd: '0.10', pollIntervalMs: 20, timeoutMs: opts.callerTimeoutMs ?? 3000 });

  const airnode = opts.airnodeFetch ? new AirnodeClient({ config: DEFAULT_AIRNODE_CONFIG, identity, store, payments, apiKeys, fetch: opts.airnodeFetch }) : undefined;
  const limiter = opts.rateLimit ? new RateLimiter(opts.rateLimit) : undefined;
  const cards = new AgentCardService({ listings, identity, payments, publicUrl, registryUrl: dns.url, defaultPriceUsd: opts.price });
  const app = createApp({
    config: { sessionJwtSecret: 'x'.repeat(40) },
    listings: () => listings,
    n8n: { apiKeys: () => apiKeys, agentDns: () => agentDns, listings: () => listings, caller: () => caller, a2a: () => a2a, rateLimiter: () => limiter, ...(airnode ? { airnode: () => airnode } : {}) },
    a2a: { a2a: () => a2a, nonces: () => nonces },
    card: { cards: () => cards },
  });

  front.handler = app as unknown as typeof front.handler;

  // a live listing with a webhook bound
  const created = await listings.create(DEV, { name: 'Weather', summary: 'Forecasts', category: 'general', tags: ['w'] });
  await listings.bindWebhook(DEV, created.id, { url: webhookUrl, secret: WEBHOOK_SECRET });
  const listing: ListingView = await listings.get(DEV, created.id);

  const callerKey: Ed25519Keypair = new IdentityService().deriveKeypair(Uint8Array.from({ length: 32 }, (_, i) => i + 50), 0);

  const message = (data: unknown = { city: 'Pune' }): A2AMessage => ({ kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'data', data }] });
  const rpc = (method: string, params: unknown, id: string | number = 1) => ({ jsonrpc: '2.0', id, method, params });

  return {
    app,
    dns,
    store,
    listings,
    listing,
    entityId: listing.entityId as string,
    tasks,
    apiKeys,
    nonces,
    keyRow,
    jobs,
    beats,
    n8n,
    fac,
    payments,
    a2a,
    caller,
    limiter,
    cards,
    agentDns,
    identity,
    webhookUrl,
    publicUrl,
    callerKey,
    message,
    rpc,
    /** POST a signed tasks/send to the listing. */
    send(opts2: { data?: unknown; headers?: Record<string, string>; signed?: boolean; method?: string } = {}) {
      const m = message(opts2.data);
      if (opts2.signed !== false) signZyndAuth(m, callerKey);
      let req = request(app).post(`/a/${encodeURIComponent(listing.entityId as string)}/a2a/v1`);
      for (const [k, v] of Object.entries(opts2.headers ?? {})) req = req.set(k, v);
      // supertest is lazy; .then() fires the request now so callers can overlap it with other work.
      return req.send(rpc(opts2.method ?? 'tasks/send', { message: m })).then((r) => r);
    },
    post(path: string, body: unknown, key: string | null = API_KEY) {
      const r = request(app).post(path);
      return (key ? r.set('X-Zynd-Api-Key', key) : r).send(body as object);
    },
    get(path: string, key: string | null = API_KEY) {
      const r = request(app).get(path);
      return key ? r.set('X-Zynd-Api-Key', key) : r;
    },
    del(path: string, key: string | null = API_KEY) {
      const r = request(app).delete(path);
      return key ? r.set('X-Zynd-Api-Key', key) : r;
    },
    async waitForJob(n = 1): Promise<Job> {
      for (let i = 0; i < 200; i++) {
        if (jobs.length >= n) return jobs[n - 1] as Job;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('webhook never received the job');
    },
    async close() {
      if (gwServer) {
        gwServer.closeAllConnections();
        await new Promise((r) => gwServer.close(r));
      }
      n8nServer.closeAllConnections();
      await new Promise((r) => n8nServer.close(r));
      await dns.close();
    },
  };
}

export type Gateway = Awaited<ReturnType<typeof makeGateway>>;

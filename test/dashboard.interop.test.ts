// M4.3 + M4.11: the dashboard's real session-token minting and Gateway client (../dashboard/src/lib/n8n)
// driving the real Gateway routes over HTTP: create -> register -> heartbeat -> searchable, API keys,
// and developer isolation. Skipped when the sibling dashboard repo is not checked out.
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { verifySessionToken } from '../src/middleware/sessionAuth.js';
import { AgentDnsClient } from '../src/services/AgentDnsClient.js';
import { ApiKeyService } from '../src/services/ApiKeyService.js';
import { IdentityService, keypairFromSeed, publicKeyString } from '../src/services/IdentityService.js';
import { ListingService } from '../src/services/ListingService.js';
import { PaymentProcessor } from '../src/services/PaymentProcessor.js';
import { WalletService } from '../src/services/WalletService.js';
import { encryptSecret, parseMasterKey } from '../src/services/keyVault.js';
import { FakeAgentDns } from './helpers/fakeAgentDns.js';
import { MemoryStore } from './helpers/memoryStore.js';
import { MemoryApiKeys, MemoryTasks } from './helpers/memoryStores.js';

const lib = resolve(__dirname, '../../dashboard/src/lib/n8n');
const present = existsSync(`${lib}/gateway.ts`);

const SECRET = 'interop-session-secret-0123456789abcdef0123456789';
const masterKey = parseMasterKey('ab'.repeat(32));
const devSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ALICE = 'zns:dev:alice';
const BOB = 'zns:dev:bob';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
// The Gateway's JSON bodies are checked field by field in the assertions.
interface Res {
  status: number;
  body: Record<string, unknown> & { id?: string; key?: string; status?: string; entityId?: string; payer?: string; listings?: unknown[]; keys?: unknown[] };
}

describe.skipIf(!present)('dashboard client against the Gateway (M4.3, M4.11)', () => {
  let server: Server;
  let dns: FakeAgentDns;
  let beats: string[];
  let env: { N8N_GATEWAY_URL: string; SESSION_JWT_SECRET: string };
  let call: (dev: string, method: Method, path: string, body?: unknown) => Promise<Res>;
  let mint: (dev: string, secret: string, opts?: { ttlSeconds?: number; nowMs?: number }) => string;
  let gatewayRequest: (dev: string, method: Method, path: string, body: unknown, deps: { env: typeof env }) => Promise<Res>;

  beforeEach(async () => {
    ({ gatewayRequest } = await import(/* @vite-ignore */ `${lib}/gateway.ts`));
    ({ mintSessionToken: mint } = await import(/* @vite-ignore */ `${lib}/session.ts`));

    dns = new FakeAgentDns();
    await dns.listen();
    const store = new MemoryStore();
    for (const dev of [ALICE, BOB]) {
      dns.developers.set(dev, publicKeyString(keypairFromSeed(devSeed).publicKey));
      store.keys.set(dev, { privateKeyEnc: encryptSecret(Buffer.from(devSeed).toString('base64'), masterKey), publicKey: '' });
    }
    const keys = new MemoryApiKeys();
    beats = [];
    const identity = new IdentityService({ masterKey, keySource: store });
    const listings = new ListingService({
      store, identity, agentDns: new AgentDnsClient(dns.url),
      heartbeats: { start: (a) => void beats.push(a.entityId), stop: async () => {} },
      publicUrl: 'https://gw.test', heartbeatRequiresWebhook: false,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const app = createApp({
      config: { sessionJwtSecret: SECRET },
      listings: () => listings,
      dashboard: {
        apiKeys: () => new ApiKeyService({ store: keys, developerExists: (id) => store.developerExists(id) }),
        tasks: () => new MemoryTasks(),
        wallet: () => new WalletService({ store, identity, payments: new PaymentProcessor({ config: loadConfig({}).x402 }) }),
      },
      n8n: { apiKeys: () => keys, listings: () => listings, agentDns: () => new AgentDnsClient(dns.url) },
    });
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    env = { N8N_GATEWAY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, SESSION_JWT_SECRET: SECRET };
    call = (dev, method, path, body) => gatewayRequest(dev, method, path, body, { env });
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await dns.close();
  });

  it('a token minted by the dashboard verifies in the Gateway, and only for the same secret', () => {
    const now = Date.now();
    expect(verifySessionToken(mint(ALICE, SECRET, { nowMs: now }), SECRET, now)).toBe(ALICE);
    expect(() => verifySessionToken(mint(ALICE, SECRET, { nowMs: now }), 'z'.repeat(40), now)).toThrow();
    expect(() => verifySessionToken(mint(ALICE, SECRET, { nowMs: now, ttlSeconds: 300 }), SECRET, now + 10 * 60_000)).toThrow(/expired/);
  });

  it('walks the listing flow: create -> register -> heartbeat -> searchable (M4.11)', async () => {
    const created = await call(ALICE, 'POST', '/listings', { name: 'Weather', summary: 'Forecasts', category: 'general', tags: ['w'], priceUsd: '0.05' });
    expect(created).toMatchObject({ status: 201, body: { status: 'DRAFT', priceUsd: '0.05' } });
    const id = created.body.id as string;

    const activated = await call(ALICE, 'POST', `/listings/${id}/activate`);
    expect(activated.status).toBe(200);
    expect(activated.body.status).toBe('ACTIVE');
    const entityId = activated.body.entityId as string;

    expect(dns.entities.get(entityId)).toMatchObject({ name: 'Weather', category: 'general' }); // registered with AgentDNS
    expect(beats).toEqual([entityId]); // heartbeat started

    const edited = await call(ALICE, 'PATCH', `/listings/${id}`, { name: 'Weather v2', tags: ['a'], priceUsd: null });
    expect(edited.body).toMatchObject({ name: 'Weather v2', tags: ['a'], priceUsd: null });
    expect((await call(ALICE, 'POST', `/listings/${id}/deactivate`)).body.status).toBe('INACTIVE');
    expect((await call(ALICE, 'DELETE', `/listings/${id}`)).body).toEqual({ id, deleted: true });
    expect((await call(ALICE, 'GET', '/listings')).body.listings).toEqual([]);
  });

  it('API keys: created through the dashboard path, usable by n8n, masked in the list, dead after revoke', async () => {
    const made = await call(ALICE, 'POST', '/api-keys', { name: 'n8n prod', permissions: ['search', 'complete'], spendCapUsd: '3' });
    expect(made.status).toBe(201);
    const plaintext = made.body.key as string;

    const list = await call(ALICE, 'GET', '/api-keys');
    expect(JSON.stringify(list.body)).not.toContain(plaintext);
    expect(list.body.keys?.[0]).toMatchObject({ name: 'n8n prod', keyPrefix: plaintext.slice(0, 8), permissions: ['search', 'complete'], spendCapUsd: '3' });

    const use = () => fetch(`${env.N8N_GATEWAY_URL}/n8n/v1/listings`, { headers: { 'X-Zynd-Api-Key': plaintext } });
    expect((await use()).status).toBe(200);
    expect((await call(ALICE, 'DELETE', `/api-keys/${made.body.id}`)).status).toBe(200);
    expect((await use()).status).toBe(401);
  });

  it('isolates developers: no cross-reads, 404 on other people’s ids', async () => {
    const a = await call(ALICE, 'POST', '/listings', { name: 'A', summary: 's', category: 'c', tags: [] });
    const k = await call(ALICE, 'POST', '/api-keys', { name: 'k' });
    expect((await call(BOB, 'GET', `/listings/${a.body.id}`)).status).toBe(404);
    expect((await call(BOB, 'PATCH', `/listings/${a.body.id}`, { name: 'x' })).status).toBe(404);
    expect((await call(BOB, 'DELETE', `/listings/${a.body.id}`)).status).toBe(404);
    expect((await call(BOB, 'DELETE', `/api-keys/${k.body.id}`)).status).toBe(404);
    expect((await call(BOB, 'GET', '/listings')).body.listings).toEqual([]);
    expect((await call(BOB, 'GET', '/api-keys')).body.keys).toEqual([]);
  });

  it('rejects a dashboard that has the wrong secret, with the Gateway’s own error', async () => {
    const res = await gatewayRequest(ALICE, 'GET', '/listings', undefined, { env: { ...env, SESSION_JWT_SECRET: 'w'.repeat(40) } });
    expect(res).toMatchObject({ status: 401, body: { code: 'AUTH_INVALID' } });
  });

  it('serves wallet and tasks to the dashboard', async () => {
    await call(ALICE, 'POST', '/listings', { name: 'A', summary: 's', category: 'c', tags: [] });
    const wallet = await call(ALICE, 'GET', '/wallet');
    expect(wallet.body.payer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(wallet.body.listings).toHaveLength(1);
    expect((await call(ALICE, 'GET', '/tasks?limit=5')).body).toEqual({ tasks: [] });
  });
});

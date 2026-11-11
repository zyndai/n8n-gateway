// M4 Gateway side: listing PATCH/DELETE (M4.1), API keys (M4.2), task history (M4.9), wallet (M4.10).
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AgentDnsClient } from '../src/services/AgentDnsClient.js';
import { ApiKeyService } from '../src/services/ApiKeyService.js';
import { IdentityService, keypairFromSeed, publicKeyString } from '../src/services/IdentityService.js';
import { ListingService } from '../src/services/ListingService.js';
import { PaymentProcessor } from '../src/services/PaymentProcessor.js';
import { WalletService } from '../src/services/WalletService.js';
import { fromHex, privateKeyToAddress } from '../src/services/evm.js';
import { decryptSecret, encryptSecret, parseMasterKey } from '../src/services/keyVault.js';
import { FakeAgentDns } from './helpers/fakeAgentDns.js';
import { TEST_SECRET, inMinutes, mintToken } from './helpers/jwt.js';
import { MemoryStore } from './helpers/memoryStore.js';
import { FakeBalances, MemoryAgentWallets, MemoryApiKeys, MemoryTasks } from './helpers/memoryStores.js';
import { loadConfig } from '../src/config.js';

const masterKey = parseMasterKey('ab'.repeat(32));
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const devSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const body = { name: 'Weather', summary: 'Forecasts', category: 'general', tags: ['weather'] };
const ALICE = 'zns:dev:alice';
const BOB = 'zns:dev:bob';
const bearer = (dev: string) => ({ Authorization: `Bearer ${mintToken({ sub: dev, exp: inMinutes(5) })}` });

let app: ReturnType<typeof createApp>;
let dns: FakeAgentDns;
let store: MemoryStore;
let keys: MemoryApiKeys;
let tasks: MemoryTasks;
let wallets: MemoryAgentWallets;
let balances: FakeBalances;
let stopped: string[];

beforeEach(async () => {
  dns = new FakeAgentDns();
  await dns.listen();
  store = new MemoryStore();
  for (const dev of [ALICE, BOB]) {
    dns.developers.set(dev, publicKeyString(keypairFromSeed(devSeed).publicKey));
    store.keys.set(dev, { privateKeyEnc: encryptSecret(Buffer.from(devSeed).toString('base64'), masterKey), publicKey: '' });
  }
  keys = new MemoryApiKeys();
  tasks = new MemoryTasks();
  stopped = [];
  wallets = new MemoryAgentWallets();
  balances = new FakeBalances();
  const identity = new IdentityService({ masterKey, keySource: store });
  const payments = new PaymentProcessor({ config: loadConfig({}).x402 });
  const walletService = new WalletService({ store, wallets, identity, payments, masterKey, balances });
  const listings = new ListingService({
    store, identity, agentDns: new AgentDnsClient(dns.url),
    heartbeats: { start: () => {}, stop: async (id) => void stopped.push(id) },
    publicUrl: 'https://gw.test', heartbeatRequiresWebhook: false, log: silent,
    onCreated: (l) => walletService.ensureListingWallet(l),
  });
  app = createApp({
    config: { sessionJwtSecret: TEST_SECRET },
    listings: () => listings,
    dashboard: {
      apiKeys: () => new ApiKeyService({ store: keys, developerExists: (id) => store.developerExists(id) }),
      tasks: () => tasks,
      wallet: () => walletService,
    },
    n8n: { apiKeys: () => keys, listings: () => listings },
  });
  return () => dns.close();
});

const create = async (dev = ALICE) => (await request(app).post('/internal/v1/listings').set(bearer(dev)).send(body)).body;

describe('PATCH/DELETE /internal/v1/listings/:id (M4.1)', () => {
  it('edits name, summary, tags, workflowId and price', async () => {
    const l = await create();
    const res = await request(app)
      .patch(`/internal/v1/listings/${l.id}`).set(bearer(ALICE))
      .send({ name: 'Weather 2', tags: ['a', 'b'], workflowId: 'wf_1', priceUsd: '0.05' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Weather 2', summary: 'Forecasts', tags: ['a', 'b'], workflowId: 'wf_1', priceUsd: '0.05' });
    const cleared = await request(app).patch(`/internal/v1/listings/${l.id}`).set(bearer(ALICE)).send({ workflowId: null, priceUsd: null });
    expect(cleared.body).toMatchObject({ workflowId: null, priceUsd: null, name: 'Weather 2' });
  });

  it('caps summary at the 200 characters AgentDNS accepts, on create and edit', async () => {
    const l = await create();
    expect((await request(app).patch(`/internal/v1/listings/${l.id}`).set(bearer(ALICE)).send({ summary: 'x'.repeat(200) })).status).toBe(200);
    expect((await request(app).post('/internal/v1/listings').set(bearer(ALICE)).send({ ...body, summary: 'x'.repeat(201) })).status).toBe(400);
  });

  it('still accepts a price-only patch (G17)', async () => {
    const l = await create();
    const res = await request(app).patch(`/internal/v1/listings/${l.id}`).set(bearer(ALICE)).send({ priceUsd: '0' });
    expect(res.body.priceUsd).toBe('0');
  });

  it('validates the patch and changes nothing on a bad one', async () => {
    const l = await create();
    for (const bad of [{}, [], { name: '' }, { name: 'x'.repeat(101) }, { summary: 'x'.repeat(201) }, { tags: 'x' }, { priceUsd: '-1' }, { priceUsd: '0.1234567' }, { name: 'ok', priceUsd: 'free' }]) {
      const res = await request(app).patch(`/internal/v1/listings/${l.id}`).set(bearer(ALICE)).send(bad as object);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await request(app).get(`/internal/v1/listings/${l.id}`).set(bearer(ALICE))).body.name).toBe('Weather');
  });

  it('deletes an active listing: heartbeat stopped, row gone', async () => {
    const l = await create();
    const act = (await request(app).post(`/internal/v1/listings/${l.id}/activate`).set(bearer(ALICE))).body;
    const res = await request(app).delete(`/internal/v1/listings/${l.id}`).set(bearer(ALICE));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: l.id, deleted: true });
    expect(stopped).toEqual([act.entityId]);
    expect((await request(app).get(`/internal/v1/listings/${l.id}`).set(bearer(ALICE))).status).toBe(404);
    expect((await request(app).get('/internal/v1/listings').set(bearer(ALICE))).body.listings).toEqual([]);
  });

  it("answers 404 for another developer's listing and leaves it alone", async () => {
    const l = await create();
    expect((await request(app).patch(`/internal/v1/listings/${l.id}`).set(bearer(BOB)).send({ name: 'hijack' })).status).toBe(404);
    expect((await request(app).delete(`/internal/v1/listings/${l.id}`).set(bearer(BOB))).status).toBe(404);
    expect((await request(app).get(`/internal/v1/listings/${l.id}`).set(bearer(ALICE))).body.name).toBe('Weather');
  });
});

describe('/internal/v1/api-keys (M4.2)', () => {
  it('returns the plaintext once, stores only a hash and shows a masked prefix after', async () => {
    const created = await request(app).post('/internal/v1/api-keys').set(bearer(ALICE)).send({ name: 'CI', spendCapUsd: '5' });
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^zk_[A-Za-z0-9_-]{32}$/);
    expect(created.body).toMatchObject({ name: 'CI', permissions: ['search', 'call', 'complete'], spendCapUsd: '5', revokedAt: null });
    expect(created.body.keyPrefix).toBe(created.body.key.slice(0, 8));
    expect(created.body).not.toHaveProperty('keyHash');

    const stored = [...keys.rows.values()][0];
    expect(JSON.stringify(stored)).not.toContain(created.body.key);

    const list = await request(app).get('/internal/v1/api-keys').set(bearer(ALICE));
    expect(list.body.keys).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(created.body.key);
    expect(list.body.keys[0]).not.toHaveProperty('key');
    expect(list.body.keys[0]).not.toHaveProperty('keyHash');
  });

  it('the new key authenticates on /n8n/v1 and a revoked key fails on its next request', async () => {
    const { body: made } = await request(app).post('/internal/v1/api-keys').set(bearer(ALICE)).send({ name: 'n8n' });
    const ok = await request(app).get('/n8n/v1/listings').set('X-Zynd-Api-Key', made.key);
    expect(ok.status).toBe(200);

    const del = await request(app).delete(`/internal/v1/api-keys/${made.id}`).set(bearer(ALICE));
    expect(del.status).toBe(200);
    expect(del.body.revokedAt).not.toBeNull();

    const after = await request(app).get('/n8n/v1/listings').set('X-Zynd-Api-Key', made.key);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('AUTH_INVALID');

    // Revoking twice keeps the first timestamp.
    const again = await request(app).delete(`/internal/v1/api-keys/${made.id}`).set(bearer(ALICE));
    expect(again.body.revokedAt).toBe(del.body.revokedAt);
  });

  it('honours permissions and expiry', async () => {
    const { body: made } = await request(app).post('/internal/v1/api-keys').set(bearer(ALICE)).send({ name: 'ro', permissions: ['search'] });
    expect(made.permissions).toEqual(['search']);
    const res = await request(app).get('/n8n/v1/listings').set('X-Zynd-Api-Key', made.key);
    expect(res.status).toBe(403);
  });

  it('validates input', async () => {
    const bad: object[] = [
      {}, { name: '' }, { name: 'x'.repeat(101) }, { name: 'k', permissions: [] }, { name: 'k', permissions: ['admin'] },
      { name: 'k', spendCapUsd: '0' }, { name: 'k', spendCapUsd: '-3' }, { name: 'k', spendCapUsd: 'lots' },
      { name: 'k', expiresAt: 'tomorrow' }, { name: 'k', expiresAt: '2001-01-01T00:00:00Z' },
    ];
    for (const payload of bad) {
      const res = await request(app).post('/internal/v1/api-keys').set(bearer(ALICE)).send(payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }
    expect(keys.rows.size).toBe(0);
  });

  it("never lists or revokes another developer's keys", async () => {
    const { body: made } = await request(app).post('/internal/v1/api-keys').set(bearer(ALICE)).send({ name: 'mine' });
    expect((await request(app).get('/internal/v1/api-keys').set(bearer(BOB))).body.keys).toEqual([]);
    expect((await request(app).delete(`/internal/v1/api-keys/${made.id}`).set(bearer(BOB))).status).toBe(404);
    expect((await request(app).get('/n8n/v1/listings').set('X-Zynd-Api-Key', made.key)).status).toBe(200);
  });

  it('requires a session token', async () => {
    expect((await request(app).post('/internal/v1/api-keys').send({ name: 'x' })).status).toBe(401);
    expect((await request(app).get('/internal/v1/api-keys')).status).toBe(401);
  });
});

describe('GET /internal/v1/tasks (M4.9)', () => {
  it('lists the developer’s tasks newest first, with metadata only, filtered and paged', async () => {
    const l = await create();
    const a = await tasks.create({ developerId: ALICE, listingId: l.id, callerId: 'zns:caller', direction: 'INBOUND', input: { secret: 'in' }, paymentUsd: '0.05' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await tasks.create({ developerId: ALICE, direction: 'OUTBOUND', input: { q: 1 } });
    await tasks.create({ developerId: BOB, direction: 'OUTBOUND', input: {} });

    const all = await request(app).get('/internal/v1/tasks').set(bearer(ALICE));
    expect(all.body.tasks.map((t: { id: string }) => t.id)).toEqual([b.id, a.id]);
    expect(JSON.stringify(all.body)).not.toContain('secret');
    expect(all.body.tasks[1]).toMatchObject({ direction: 'INBOUND', listingId: l.id, status: 'PENDING', paymentUsd: '0.05' });

    const byListing = await request(app).get(`/internal/v1/tasks?listingId=${l.id}`).set(bearer(ALICE));
    expect(byListing.body.tasks.map((t: { id: string }) => t.id)).toEqual([a.id]);
    const out = await request(app).get('/internal/v1/tasks?direction=OUTBOUND&limit=1').set(bearer(ALICE));
    expect(out.body.tasks.map((t: { id: string }) => t.id)).toEqual([b.id]);
    const page2 = await request(app).get('/internal/v1/tasks?limit=1&offset=1').set(bearer(ALICE));
    expect(page2.body.tasks.map((t: { id: string }) => t.id)).toEqual([a.id]);
  });

  it('rejects bad query values', async () => {
    for (const q of ['direction=SIDEWAYS', 'limit=0', 'limit=101', 'limit=x', 'offset=-1']) {
      expect((await request(app).get(`/internal/v1/tasks?${q}`).set(bearer(ALICE))).status, q).toBe(400);
    }
  });
});

describe('GET /internal/v1/wallet (M4.10)', () => {
  it('returns the payer address and one receiving address per listing, derived like the payment path', async () => {
    const l1 = await create();
    const l2 = await create();
    const res = await request(app).get('/internal/v1/wallet').set(bearer(ALICE));
    expect(res.status).toBe(200);

    const payments = new PaymentProcessor({ config: loadConfig({}).x402 });
    const identity = new IdentityService({ masterKey, keySource: store });
    const dev = keypairFromSeed(devSeed);
    expect(res.body.payer).toBe(payments.evmAddress(dev.privateKey));
    expect(res.body.payer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const expected = (index: number) => payments.evmAddress(identity.deriveKeypair(devSeed, index).privateKey);
    const byId = new Map<string, { name: string; address: string }>(res.body.listings.map((x: { listingId: string; name: string; address: string }) => [x.listingId, x]));
    expect(byId.get(l1.id)?.address).toBe(expected(0));
    expect(byId.get(l2.id)?.address).toBe(expected(1));
    expect(res.body.listings).toHaveLength(2);
    expect(res.body.listings[0].address).not.toBe(res.body.listings[1].address);
    expect(JSON.stringify(res.body)).not.toMatch(/priv|seed|secret/i);
  });

  it('stores one encrypted wallet per listing when the listing is created', async () => {
    const l = await create();
    expect(wallets.rows).toHaveLength(1);
    const row = wallets.rows[0]!;
    expect(row).toMatchObject({ listingId: l.id, developerId: ALICE, derivedKeyIndex: 0 });
    // The key is encrypted at rest and is the one the payment path derives from the listing seed.
    const key = decryptSecret(row.privateKeyEnc, masterKey);
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(row.privateKeyEnc).not.toContain(key.slice(2));
    expect(privateKeyToAddress(fromHex(key))).toBe(row.address);
    const payments = new PaymentProcessor({ config: loadConfig({}).x402 });
    const identity = new IdentityService({ masterKey, keySource: store });
    expect(row.address).toBe(payments.evmAddress(identity.deriveKeypair(devSeed, 0).privateKey));
    // The wallet view serves that same address.
    const view = await request(app).get('/internal/v1/wallet').set(bearer(ALICE));
    expect(view.body.listings[0].address).toBe(row.address);
    expect(wallets.rows).toHaveLength(1);
  });

  it('creates the wallet of a listing that predates the table, with the same address', async () => {
    const l = await create();
    wallets.rows = []; // as if the listing had been created before the migration
    const res = await request(app).get('/internal/v1/wallet').set(bearer(ALICE));
    expect(wallets.rows).toHaveLength(1);
    expect(res.body.listings[0]).toMatchObject({ listingId: l.id, address: wallets.rows[0]!.address });
  });

  it('reports USD balances, and null when the chain cannot be read', async () => {
    const l = await create();
    const payer = (await request(app).get('/internal/v1/wallet').set(bearer(ALICE))).body.payer as string;
    const address = wallets.rows[0]!.address;
    expect((await request(app).get('/internal/v1/wallet').set(bearer(ALICE))).body).toMatchObject({ payerBalanceUsd: null, listings: [{ listingId: l.id, balanceUsd: null }] });
    balances.byAddress = { [payer]: '2.500000', [address]: '0.120000' };
    expect((await request(app).get('/internal/v1/wallet').set(bearer(ALICE))).body).toMatchObject({ payerBalanceUsd: '2.500000', listings: [{ balanceUsd: '0.120000' }] });
  });

  it('keeps the wallet of a deleted listing (it may still hold funds) but no longer lists it', async () => {
    const l = await create();
    const del = await request(app).delete(`/internal/v1/listings/${l.id}`).set(bearer(ALICE));
    expect(del.status).toBe(200);
    expect(wallets.rows).toHaveLength(1);
    expect((await request(app).get('/internal/v1/wallet').set(bearer(ALICE))).body.listings).toEqual([]);
  });

  it('does not fail listing creation when the wallet cannot be stored', async () => {
    wallets.put = async () => {
      throw new Error('db down');
    };
    const res = await request(app).post('/internal/v1/listings').set(bearer(ALICE)).send(body);
    expect(res.status).toBe(201);
  });
});

describe('POST /internal/v1/api-keys/:id/rotate (M6.4)', () => {
  it('returns the new plaintext once and keeps the old key working during the grace period', async () => {
    const { body: old } = await request(app).post('/internal/v1/api-keys').set(bearer(ALICE)).send({ name: 'n8n' });
    const res = await request(app).post(`/internal/v1/api-keys/${old.id}/rotate`).set(bearer(ALICE)).send({ graceHours: 1 });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^zk_/);
    expect(res.body.previous).toMatchObject({ id: old.id });
    expect(res.body.previous).not.toHaveProperty('key');
    expect(JSON.stringify([...keys.rows.values()])).not.toContain(res.body.key);

    for (const k of [old.key, res.body.key]) {
      expect((await request(app).get('/n8n/v1/listings').set('X-Zynd-Api-Key', k)).status).toBe(200);
    }
    const noBody = await request(app).post(`/internal/v1/api-keys/${old.id}/rotate`).set(bearer(ALICE));
    expect(noBody.status).toBe(201);
  });

  it("answers 404 for another developer's key and 400 for a bad grace period", async () => {
    const { body: made } = await request(app).post('/internal/v1/api-keys').set(bearer(ALICE)).send({ name: 'mine' });
    expect((await request(app).post(`/internal/v1/api-keys/${made.id}/rotate`).set(bearer(BOB))).status).toBe(404);
    expect((await request(app).post(`/internal/v1/api-keys/${made.id}/rotate`).set(bearer(ALICE)).send({ graceHours: -1 })).status).toBe(400);
    expect(keys.rows.size).toBe(1);
  });
});

describe('GET /internal/v1/analytics (M6.2)', () => {
  const seed = async (dev: string, listingId: string | null, status: 'COMPLETED' | 'FAILED' | 'TIMEOUT' | 'CANCELED' | 'PENDING', opts: { paid?: string; daysAgo?: number; direction?: 'INBOUND' | 'OUTBOUND' } = {}) => {
    const t = await tasks.create({ developerId: dev, listingId, direction: opts.direction ?? 'INBOUND', input: {}, paymentUsd: opts.paid ?? null });
    await tasks.transition(t.id, ['PENDING'], status, opts.paid && status === 'COMPLETED' ? { paymentTxn: '0xabc' } : {});
    if (opts.daysAgo) tasks.rows.set(t.id, { ...tasks.rows.get(t.id)!, createdAt: new Date(Date.now() - opts.daysAgo * 86_400_000) });
  };

  it('counts calls, revenue and error rate per listing and day', async () => {
    const a = await create();
    const b = await create();
    await seed(ALICE, a.id, 'COMPLETED', { paid: '0.05' });
    await seed(ALICE, a.id, 'COMPLETED', { paid: '0.05' });
    await seed(ALICE, a.id, 'FAILED', { paid: '0.05' }); // failed calls are not charged
    await seed(ALICE, a.id, 'TIMEOUT');
    await seed(ALICE, a.id, 'CANCELED');
    await seed(ALICE, a.id, 'COMPLETED', { paid: '0.05', daysAgo: 3 });
    await seed(ALICE, b.id, 'COMPLETED');
    await seed(ALICE, a.id, 'COMPLETED', { direction: 'OUTBOUND', paid: '9' }); // outbound is not listing revenue
    await seed(BOB, null, 'COMPLETED', { paid: '7' });

    const res = await request(app).get('/internal/v1/analytics').set(bearer(ALICE));
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    const ta = res.body.totals.find((t: { listingId: string }) => t.listingId === a.id);
    expect(ta).toMatchObject({ calls: 6, completed: 3, failed: 2, revenueUsd: '0.150000' });
    expect(ta.errorRate).toBeCloseTo(0.4);
    expect(res.body.totals.find((t: { listingId: string }) => t.listingId === b.id)).toMatchObject({ calls: 1, errorRate: 0, revenueUsd: '0.000000' });
    expect(res.body.totals).toHaveLength(2);
    expect(res.body.series.filter((d: { listingId: string }) => d.listingId === a.id)).toHaveLength(2); // today + 3 days ago
    const days = res.body.series.map((d: { day: string }) => d.day);
    expect([...days].sort()).toEqual(days);
  });

  it('filters by listing and window, and rejects bad input', async () => {
    const a = await create();
    const b = await create();
    await seed(ALICE, a.id, 'COMPLETED');
    await seed(ALICE, b.id, 'COMPLETED');
    await seed(ALICE, a.id, 'COMPLETED', { daysAgo: 10 });
    const one = await request(app).get(`/internal/v1/analytics?listingId=${a.id}&days=7`).set(bearer(ALICE));
    expect(one.body.totals).toHaveLength(1);
    expect(one.body.totals[0]).toMatchObject({ listingId: a.id, calls: 1 });
    for (const q of ['days=0', 'days=366', 'days=x']) {
      expect((await request(app).get(`/internal/v1/analytics?${q}`).set(bearer(ALICE))).status, q).toBe(400);
    }
    const empty = await request(app).get('/internal/v1/analytics').set(bearer(BOB));
    expect(empty.body).toMatchObject({ series: [], totals: [] });
  });
});

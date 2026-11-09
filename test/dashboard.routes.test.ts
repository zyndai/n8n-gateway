import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AgentDnsClient } from '../src/services/AgentDnsClient.js';
import { IdentityService, keypairFromSeed, publicKeyString } from '../src/services/IdentityService.js';
import { ListingService } from '../src/services/ListingService.js';
import { encryptSecret, parseMasterKey } from '../src/services/keyVault.js';
import { FakeAgentDns } from './helpers/fakeAgentDns.js';
import { TEST_SECRET, inMinutes, mintToken } from './helpers/jwt.js';
import { MemoryStore } from './helpers/memoryStore.js';

const masterKey = parseMasterKey('ab'.repeat(32));
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const devSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const body = { name: 'Weather', summary: 'Forecasts', category: 'general', tags: ['weather'] };
const bearer = (dev: string) => ({ Authorization: `Bearer ${mintToken({ sub: dev, exp: inMinutes(5) })}` });

let app: ReturnType<typeof createApp>;
let dns: FakeAgentDns;

beforeEach(async () => {
  dns = new FakeAgentDns();
  await dns.listen();
  const store = new MemoryStore();
  for (const dev of ['zns:dev:alice', 'zns:dev:bob']) {
    dns.developers.set(dev, publicKeyString(keypairFromSeed(devSeed).publicKey));
    store.keys.set(dev, { privateKeyEnc: encryptSecret(Buffer.from(devSeed).toString('base64'), masterKey), publicKey: '' });
  }
  const identity = new IdentityService({ masterKey, keySource: store });
  const listings = new ListingService({
    store, identity, agentDns: new AgentDnsClient(dns.url),
    heartbeats: { start: () => {}, stop: async () => {} },
    publicUrl: 'https://gw.test', heartbeatRequiresWebhook: false, log: silent,
  });
  app = createApp({ config: { sessionJwtSecret: TEST_SECRET }, listings: () => listings });
  return () => dns.close();
});

describe('/internal/v1 auth (M1.8, M4.3)', () => {
  it('rejects missing, malformed, expired and forged tokens', async () => {
    expect((await request(app).get('/internal/v1/listings')).body.code).toBe('AUTH_INVALID');
    expect((await request(app).get('/internal/v1/listings').set('Authorization', 'Bearer nope')).status).toBe(401);
    const expired = mintToken({ sub: 'zns:dev:alice', exp: inMinutes(-10) });
    const res = await request(app).get('/internal/v1/listings').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_EXPIRED');
    const forged = mintToken({ sub: 'zns:dev:alice', exp: inMinutes(5) }, { secret: 'y'.repeat(40) });
    expect((await request(app).get('/internal/v1/listings').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
  });

  it('fails closed (500, no detail) when the server has no usable secret', async () => {
    const weak = createApp({ config: { sessionJwtSecret: 'short' }, listings: () => { throw new Error('unused'); } });
    const res = await request(weak).get('/internal/v1/listings').set(bearer('zns:dev:alice'));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error', code: 'INTERNAL' });
  });
});

describe('/internal/v1/listings', () => {
  it('create -> activate -> get: a dashboard JWT can trigger registration (M1.8)', async () => {
    const created = await request(app).post('/internal/v1/listings').set(bearer('zns:dev:alice')).send(body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'DRAFT', derivedKeyIndex: 0, entityId: null });
    expect(created.body).not.toHaveProperty('webhookSecretEnc');

    const act = await request(app).post(`/internal/v1/listings/${created.body.id}/activate`).set(bearer('zns:dev:alice'));
    expect(act.status).toBe(200);
    expect(act.body.status).toBe('ACTIVE');
    expect(act.body.entityId).toMatch(/^zns:[0-9a-f]{32}$/);
    expect(dns.entities.has(act.body.entityId)).toBe(true);

    const got = await request(app).get(`/internal/v1/listings/${created.body.id}`).set(bearer('zns:dev:alice'));
    expect(got.body.entityUrl).toBe(`https://gw.test/a/${act.body.entityId}`);

    const list = await request(app).get('/internal/v1/listings').set(bearer('zns:dev:alice'));
    expect(list.body.listings).toHaveLength(1);
  });

  it("never lets one developer see or drive another's listing", async () => {
    const created = await request(app).post('/internal/v1/listings').set(bearer('zns:dev:alice')).send(body);
    const id = created.body.id;
    for (const [method, path] of [['get', ''], ['post', '/activate'], ['post', '/deactivate']] as const) {
      const res = await request(app)[method](`/internal/v1/listings/${id}${path}`).set(bearer('zns:dev:bob'));
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    const list = await request(app).get('/internal/v1/listings').set(bearer('zns:dev:bob'));
    expect(list.body.listings).toEqual([]);
    expect(dns.registerCalls).toBe(0);
  });

  it('deactivates', async () => {
    const id = (await request(app).post('/internal/v1/listings').set(bearer('zns:dev:alice')).send(body)).body.id;
    await request(app).post(`/internal/v1/listings/${id}/activate`).set(bearer('zns:dev:alice'));
    const res = await request(app).post(`/internal/v1/listings/${id}/deactivate`).set(bearer('zns:dev:alice'));
    expect(res.body.status).toBe('INACTIVE');
  });

  it('surfaces a registry outage as 502 GATEWAY_UNAVAILABLE', async () => {
    dns.failRegistration = true;
    const id = (await request(app).post('/internal/v1/listings').set(bearer('zns:dev:alice')).send(body)).body.id;
    const res = await request(app).post(`/internal/v1/listings/${id}/activate`).set(bearer('zns:dev:alice'));
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('GATEWAY_UNAVAILABLE');
  });

  it('validates input', async () => {
    const bad: unknown[] = [
      {}, { ...body, name: '' }, { ...body, name: 'x'.repeat(101) }, { ...body, tags: 'nope' },
      { ...body, tags: Array(11).fill('t') }, { ...body, summary: 5 }, [], null,
    ];
    for (const payload of bad) {
      const res = await request(app).post('/internal/v1/listings').set(bearer('zns:dev:alice')).send(payload as object);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    }
  });

  it('answers 404 for an unknown developer rather than a 500', async () => {
    const res = await request(app).post('/internal/v1/listings').set(bearer('zns:dev:ghost')).send(body);
    expect(res.status).toBe(404);
  });
});

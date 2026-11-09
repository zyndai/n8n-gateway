// M1 exit gate, scripted (M1.13): create -> register -> heartbeat -> active in the registry ->
// stop -> inactive after 300 s, plus restart recovery (M1.11) and fault injection (M1.10), against
// real Postgres and a fake AgentDNS that enforces the registry's signature/proof/clock checks over
// real HTTP + WebSocket. Runs only with TEST_DATABASE_URL (migrations applied, developer_keys present).
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { developerKey } from '../src/db/dashboard.js';
import { disconnectDb, getDb } from '../src/db/client.js';
import { n8nDerivationCounter, n8nHeartbeat, n8nListing } from '../src/db/schema.js';
import { AgentDnsClient } from '../src/services/AgentDnsClient.js';
import { HeartbeatManager } from '../src/services/HeartbeatManager.js';
import { IdentityService, keypairFromSeed, publicKeyString } from '../src/services/IdentityService.js';
import { ListingService } from '../src/services/ListingService.js';
import { ListingStore } from '../src/services/ListingStore.js';
import { encryptSecret, parseMasterKey } from '../src/services/keyVault.js';
import { FakeAgentDns } from './helpers/fakeAgentDns.js';

const url = process.env.TEST_DATABASE_URL;
const masterKey = parseMasterKey('cd'.repeat(32));
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const input = { name: 'Weather', summary: 'Forecasts', category: 'general', tags: ['weather'] };

async function waitFor(cond: () => boolean | Promise<boolean>, what: string, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!url)('M1 end to end (Postgres + fake AgentDNS)', () => {
  const devSeed = Uint8Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
  const devId = `zns:dev:m1_${Date.now()}`;
  const stray: string[] = [];
  let dns: FakeAgentDns;
  let store: ListingStore;
  let identity: IdentityService;
  const managers: HeartbeatManager[] = [];

  function build(opts: { requiresWebhook?: boolean } = {}) {
    const agentDns = new AgentDnsClient(dns.url);
    const heartbeats = new HeartbeatManager({
      heartbeatUrl: (id) => agentDns.heartbeatUrl(id),
      identity,
      store,
      log: silent,
      intervalMs: 100,
      baseDelayMs: 25,
      maxDelayMs: 200,
      loadActive: () => store.loadActive(opts.requiresWebhook ?? true),
    });
    managers.push(heartbeats);
    const listings = new ListingService({
      store, identity, agentDns, heartbeats,
      publicUrl: 'https://gw.test', heartbeatRequiresWebhook: opts.requiresWebhook ?? true, log: silent,
    });
    return { heartbeats, listings };
  }

  const bindWebhook = (listingId: string) =>
    getDb().update(n8nListing).set({ webhookUrl: 'https://n8n.test/hook' }).where(eq(n8nListing.id, listingId));
  const hbRow = async (listingId: string) =>
    (await getDb().select().from(n8nHeartbeat).where(eq(n8nHeartbeat.listingId, listingId)))[0];

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    store = new ListingStore(getDb());
    identity = new IdentityService({ masterKey, keySource: store });
    dns = new FakeAgentDns();
    await dns.listen();
    dns.developers.set(devId, publicKeyString(keypairFromSeed(devSeed).publicKey));
    await getDb().insert(developerKey).values({
      id: randomUUID(),
      userId: `u_${devId}`,
      developerId: devId,
      publicKey: publicKeyString(keypairFromSeed(devSeed).publicKey),
      privateKeyEnc: encryptSecret(Buffer.from(devSeed).toString('base64'), masterKey),
      name: 'm1 test',
    });
  });

  afterEach(() => {
    while (managers.length) managers.pop()?.shutdown();
  });

  afterAll(async () => {
    const db = getDb();
    const rows = await db.select({ id: n8nListing.id }).from(n8nListing).where(eq(n8nListing.developerId, devId));
    const ids = [...rows.map((r) => r.id), ...stray];
    if (ids.length) await db.delete(n8nHeartbeat).where(inArray(n8nHeartbeat.listingId, ids));
    await db.delete(n8nListing).where(eq(n8nListing.developerId, devId));
    await db.delete(n8nDerivationCounter).where(eq(n8nDerivationCounter.developerId, devId));
    await db.delete(developerKey).where(eq(developerKey.developerId, devId));
    await disconnectDb();
    await dns.close();
  });

  it('allocates unique derivation indexes under concurrent creates (M1.2, G13)', async () => {
    const created = await Promise.all(Array.from({ length: 25 }, () => store.createListing(devId, input)));
    const idx = created.map((l) => l.derivedKeyIndex).sort((a, b) => a - b);
    expect(new Set(idx).size).toBe(25);
    expect(idx[0]).toBeDefined();
    expect(idx[24]! - idx[0]!).toBe(24); // gap-free
  });

  it('only one of two concurrent transitions wins (M1.6 compare-and-set)', async () => {
    const l = await store.createListing(devId, input);
    const [a, b] = await Promise.all([store.transition(l.id, 'REGISTERING'), store.transition(l.id, 'REGISTERING')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await store.transition(l.id, 'DRAFT' as never)).toBeUndefined(); // nothing may enter DRAFT
    expect(await store.claimStaleRegistration(l.id)).toBeUndefined(); // fresh, not stale
    expect(await store.claimStaleRegistration(l.id, new Date(Date.now() + 3 * 60_000))).toBeDefined();
  });

  it('create -> register -> heartbeat -> searchable -> stop -> inactive after 300 s', async () => {
    const { listings } = build();
    const l = await listings.create(devId, input);
    await bindWebhook(l.id);

    const active = await listings.activate(devId, l.id);
    expect(active.status).toBe('ACTIVE');
    const entityId = active.entityId as string;
    expect(dns.entities.get(entityId)?.entity_url).toBe(`https://gw.test/a/${entityId}`);

    // Signed beats reach the registry and the registry marks the agent active.
    await waitFor(() => dns.validBeats >= 3, 'three valid heartbeats');
    expect(dns.invalidBeats).toBe(0);
    expect(dns.isActive(entityId)).toBe(true);
    await waitFor(async () => (await hbRow(l.id))?.status === 'ACTIVE' && !!(await hbRow(l.id))?.lastBeatAt, 'ACTIVE row');
    const first = (await hbRow(l.id))?.lastBeatAt?.getTime() ?? 0;
    await waitFor(async () => ((await hbRow(l.id))?.lastBeatAt?.getTime() ?? 0) > first, 'lastBeatAt to advance');

    // Stop: row goes STOPPED (G8), beats cease, registry marks inactive after the 300 s threshold.
    const stopped = await listings.deactivate(devId, l.id);
    expect(stopped.status).toBe('INACTIVE');
    await waitFor(async () => (await hbRow(l.id))?.status === 'STOPPED', 'STOPPED row');
    const beats = dns.validBeats;
    await new Promise((r) => setTimeout(r, 350));
    expect(dns.validBeats).toBe(beats);
    expect(dns.isActive(entityId)).toBe(true); // still inside the 300 s window
    expect(dns.isActive(entityId, Date.now() + 301_000)).toBe(false);
  });

  it('resumes heartbeats for ACTIVE listings after a Gateway restart (M1.11)', async () => {
    const first = build();
    const l = await first.listings.create(devId, input);
    await bindWebhook(l.id);
    const { entityId } = await first.listings.activate(devId, l.id);
    await waitFor(() => (dns.entities.get(entityId as string)?.lastHeartbeatAt ?? 0) > 0, 'first beat');

    first.heartbeats.shutdown(); // process exit: sockets die, DB rows untouched
    identity.invalidate(l.id);
    expect((await hbRow(l.id))?.status).not.toBe('STOPPED');
    const mark = dns.entities.get(entityId as string)?.lastHeartbeatAt ?? 0;

    const second = build(); // fresh process
    const result = await second.heartbeats.resumeActive();
    expect(result.started).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    await waitFor(() => (dns.entities.get(entityId as string)?.lastHeartbeatAt ?? 0) > mark, 'beats after restart');
  });

  it('a registered listing without a webhook is not resumed when the webhook is required (G7)', async () => {
    const { listings, heartbeats } = build();
    const l = await listings.create(devId, input);
    const { entityId } = await listings.activate(devId, l.id);
    await new Promise((r) => setTimeout(r, 150));
    expect(heartbeats.has(entityId as string)).toBe(false);
    const targets = await store.loadActive(true);
    expect(targets.some((t) => t.listingId === l.id)).toBe(false);
    expect((await store.loadActive(false)).some((t) => t.listingId === l.id)).toBe(true);
  });

  it('reconnects with backoff when AgentDNS drops every socket (M1.10 fault injection)', async () => {
    const { listings, heartbeats } = build();
    const l = await listings.create(devId, input);
    await bindWebhook(l.id);
    const { entityId } = await listings.activate(devId, l.id);
    await waitFor(() => heartbeats.has(entityId as string) && (dns.entities.get(entityId as string)?.lastHeartbeatAt ?? 0) > 0, 'first beat');

    const mark = dns.entities.get(entityId as string)?.lastHeartbeatAt ?? 0;
    dns.dropSockets();
    await waitFor(() => (dns.entities.get(entityId as string)?.lastHeartbeatAt ?? 0) > mark, 'beat after reconnect');
    await waitFor(async () => (await hbRow(l.id))?.status === 'ACTIVE', 'ACTIVE again');
  });
});

// M2 against real Postgres: the atomic spend counter (M2.16), task compare-and-set (M2.11/M2.12),
// nonce claims (M2.6), webhook columns (M2.5), and the full inbound + outbound flows with the SQL
// stores plugged in. Runs only with TEST_DATABASE_URL (migrations applied, developer_keys present).
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDb, getDb } from '../src/db/client.js';
import { developerKey } from '../src/db/dashboard.js';
import { n8nApiKey, n8nDerivationCounter, n8nHeartbeat, n8nListing, n8nNonce, n8nTask } from '../src/db/schema.js';
import { hashApiKey } from '../src/middleware/apiKeyAuth.js';
import { ListingStore } from '../src/services/ListingStore.js';
import { encryptSecret } from '../src/services/keyVault.js';
import { ApiKeyStore } from '../src/services/ApiKeyStore.js';
import { NonceStore } from '../src/services/NonceStore.js';
import { TaskStore } from '../src/services/TaskStore.js';
import { parseUsd } from '../src/services/money.js';
import { FakeRemoteAgent } from './helpers/fakeRemoteAgent.js';
import { API_KEY, DEV, devSeed, makeGateway, masterKey } from './helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('M2 on Postgres', () => {
  const stray = { keys: [] as string[], nonces: [] as string[], tasks: [] as string[] };
  let apiKeys: ApiKeyStore;
  let tasks: TaskStore;
  let nonces: NonceStore;
  const devId = DEV;

  async function newKey(fields: Partial<typeof n8nApiKey.$inferInsert> = {}, plaintext = `zk_${randomUUID()}`) {
    const [row] = await getDb()
      .insert(n8nApiKey)
      .values({ developerId: devId, name: 't', keyHash: hashApiKey(plaintext), keyPrefix: plaintext.slice(0, 8), ...fields })
      .returning();
    stray.keys.push(row!.id);
    return { row: row!, plaintext };
  }
  const spent = async (id: string) => parseUsd((await getDb().select().from(n8nApiKey).where(eq(n8nApiKey.id, id)))[0]!.spentUsd);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const db = getDb();
    apiKeys = new ApiKeyStore(db);
    tasks = new TaskStore(db);
    nonces = new NonceStore(db);
    // The harness derives listing keys from this seed, so the developer row must hold it.
    const privateKeyEnc = encryptSecret(Buffer.from(devSeed).toString('base64'), masterKey);
    await db.insert(developerKey).values({ id: randomUUID(), userId: `u_${devId}_${Date.now()}`, developerId: devId, publicKey: '', privateKeyEnc, name: 'm2' }).onConflictDoNothing();
  });

  afterAll(async () => {
    const db = getDb();
    if (stray.tasks.length) await db.delete(n8nTask).where(inArray(n8nTask.id, stray.tasks));
    await db.delete(n8nTask).where(eq(n8nTask.developerId, devId));
    const mine = (await db.select({ id: n8nListing.id }).from(n8nListing).where(eq(n8nListing.developerId, devId))).map((r) => r.id);
    if (mine.length) await db.delete(n8nHeartbeat).where(inArray(n8nHeartbeat.listingId, mine));
    await db.delete(n8nListing).where(eq(n8nListing.developerId, devId));
    await db.delete(n8nDerivationCounter).where(eq(n8nDerivationCounter.developerId, devId));
    if (stray.keys.length) await db.delete(n8nApiKey).where(inArray(n8nApiKey.id, stray.keys));
    if (stray.nonces.length) await db.delete(n8nNonce).where(inArray(n8nNonce.nonce, stray.nonces));
    await db.delete(developerKey).where(eq(developerKey.developerId, devId));
    await disconnectDb();
  });

  describe('spend counter (M2.16)', () => {
    it('never overshoots the cap under 40 concurrent reservations', async () => {
      const { row } = await newKey({ spendCapUsd: '1.000000' });
      const results = await Promise.all(Array.from({ length: 40 }, () => apiKeys.reserveSpend(row.id, parseUsd('0.05'))));
      expect(results.filter(Boolean)).toHaveLength(20);
      expect(await spent(row.id)).toBe(parseUsd('1'));
    });

    it('lets the last cent through and refuses the next one', async () => {
      const { row } = await newKey({ spendCapUsd: '0.100000' });
      expect(await apiKeys.reserveSpend(row.id, parseUsd('0.099999'))).toBe(true);
      expect(await apiKeys.reserveSpend(row.id, parseUsd('0.000001'))).toBe(true);
      expect(await apiKeys.reserveSpend(row.id, parseUsd('0.000001'))).toBe(false);
    });

    it('has no limit when no cap is set, refunds, and never goes negative', async () => {
      const { row } = await newKey();
      expect(await apiKeys.reserveSpend(row.id, parseUsd('1000'))).toBe(true);
      await apiKeys.refundSpend(row.id, parseUsd('400'));
      expect(await spent(row.id)).toBe(parseUsd('600'));
      await apiKeys.refundSpend(row.id, parseUsd('9999'));
      expect(await spent(row.id)).toBe(0n);
    });

    it('reserves nothing for an unknown key', async () => {
      expect(await apiKeys.reserveSpend(randomUUID(), 1n)).toBe(false);
    });

    it('finds keys by hash and records lastUsedAt', async () => {
      const { row, plaintext } = await newKey();
      const found = await apiKeys.findByHash(hashApiKey(plaintext));
      expect(found?.id).toBe(row.id);
      expect(await apiKeys.findByHash(hashApiKey('nope'))).toBeUndefined();
      const at = new Date();
      await apiKeys.touch(row.id, at);
      expect((await apiKeys.findByHash(hashApiKey(plaintext)))?.lastUsedAt?.getTime()).toBe(at.getTime());
    });
  });

  describe('tasks (M2.11, M2.12)', () => {
    const make = () => tasks.create({ developerId: devId, direction: 'INBOUND', input: { a: 1 } });

    it('applies only the first of racing completions', async () => {
      const t = await make();
      const outcomes = await Promise.all([
        tasks.transition(t.id, ['PENDING', 'PROCESSING'], 'COMPLETED', { output: { n: 1 } }),
        tasks.transition(t.id, ['PENDING', 'PROCESSING'], 'FAILED', { error: 'x' }),
        tasks.transition(t.id, ['PENDING', 'PROCESSING'], 'TIMEOUT', { error: 'late' }),
      ]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
    });

    it('refuses a late completion of a TIMEOUT / CANCELED task and keeps jsonb output intact', async () => {
      const t = await make();
      await tasks.transition(t.id, ['PENDING'], 'PROCESSING');
      expect(await tasks.transition(t.id, ['PENDING', 'PROCESSING'], 'CANCELED', { error: 'Canceled by caller' })).toMatchObject({ status: 'CANCELED' });
      expect(await tasks.transition(t.id, ['PENDING', 'PROCESSING'], 'COMPLETED', { output: 1 })).toBeUndefined();
      const u = await make();
      const done = await tasks.transition(u.id, ['PENDING'], 'COMPLETED', { output: { deep: [1, { x: 'é' }], nul: null } });
      expect(done?.output).toEqual({ deep: [1, { x: 'é' }], nul: null });
    });

    it('stores payment details and a listing-less OUTBOUND task (G3)', async () => {
      const { row } = await newKey();
      const t = await tasks.create({ developerId: devId, direction: 'OUTBOUND', apiKeyId: row.id, input: 'text' });
      await tasks.setPayment(t.id, { paymentUsd: '0.050000', paymentTxn: '0xabc' });
      expect(await tasks.get(t.id)).toMatchObject({ listingId: null, apiKeyId: row.id, paymentUsd: '0.050000', paymentTxn: '0xabc', status: 'PENDING' });
    });
  });

  describe('nonces (M2.6)', () => {
    it('claims once even when raced, and purges only expired rows', async () => {
      const key = `zns:test:${randomUUID()}`;
      const live = `${key}:live`;
      stray.nonces.push(key, live);
      const wins = await Promise.all(Array.from({ length: 20 }, () => nonces.claim(key, new Date(Date.now() - 1000))));
      expect(wins.filter(Boolean)).toHaveLength(1);
      await nonces.claim(live, new Date(Date.now() + 60_000));
      expect(await nonces.purgeExpired()).toBeGreaterThanOrEqual(1);
      expect(await nonces.claim(key, new Date(Date.now() + 60_000))).toBe(true); // purged, so claimable again
      expect(await nonces.claim(live, new Date(Date.now() + 60_000))).toBe(false); // still held
    });
  });

  describe('listing price (G17)', () => {
    it('stores a price at create, updates and resets it, and only for the owner', async () => {
      const store = new ListingStore(getDb());
      const base = { name: 'Priced', summary: 's', category: 'c', tags: [] as string[] };
      const free = await store.createListing(devId, base);
      expect(free.priceUsd).toBeNull();
      const priced = await store.createListing(devId, { ...base, priceUsd: '0.05' });
      expect(priced.priceUsd).toBe('0.050000'); // numeric(18,6)
      expect((await store.setPrice(devId, priced.id, '0.5'))?.priceUsd).toBe('0.500000');
      expect((await store.setPrice(devId, priced.id, null))?.priceUsd).toBeNull();
      expect(await store.setPrice('zns:dev:someone-else', priced.id, '1')).toBeUndefined();
    });
  });

  describe('flows with SQL stores', () => {
    it('inbound: signed call -> n8n -> jobs/complete -> A2A result, replay refused', async () => {
      const { plaintext } = await newKey({}, API_KEY + '_db_inbound');
      const gw = await makeGateway({ stores: { tasks, apiKeys, nonces }, listingStore: new ListingStore(getDb()) });
      try {
        const pending = gw.send();
        const job = await gw.waitForJob();
        const done = await gw.post(`/n8n/v1/jobs/${job.payload.jobId}/complete`, { output: { ok: true } }, plaintext);
        expect(done.body.status).toBe('COMPLETED');
        const res = await pending;
        expect(res.body.result).toMatchObject({ status: { state: 'completed' }, artifacts: [{ parts: [{ data: { ok: true } }] }] });
        stray.tasks.push(job.payload.jobId);
        expect(await tasks.get(job.payload.jobId)).toMatchObject({ status: 'COMPLETED', direction: 'INBOUND', output: { ok: true }, listingId: gw.listing.id });
        // webhook columns round-trip through SQL, secret encrypted
        const row = await new ListingStore(getDb()).getByEntityId(gw.entityId);
        expect(row).toMatchObject({ webhookUrl: gw.webhookUrl, status: 'ACTIVE' });
        expect(row?.webhookSecretEnc).not.toContain('webhook-secret');
        expect(await new ListingStore(getDb()).findByWebhookUrl(DEV, gw.webhookUrl)).toHaveLength(1);
        expect(await new ListingStore(getDb()).setWebhook('zns:dev:stranger', gw.listing.id, null)).toBeUndefined();
      } finally {
        await gw.close();
      }
    });

    it('outbound: paid call debits the key in SQL and respects the cap', async () => {
      const { row, plaintext } = await newKey({ spendCapUsd: '0.08' });
      const gw = await makeGateway({ stores: { tasks, apiKeys, nonces } });
      const remote = new FakeRemoteAgent({ priceUsd: '0.05' });
      await remote.listen();
      const id = 'zns:remote00000000000000000000000db1';
      gw.dns.entities.set(id, { entity_id: id, public_key: '', entity_url: remote.url, name: 'R', category: 'c', tags: [], summary: 's', developer_id: 'd' });
      try {
        const first = await gw.post(`/n8n/v1/agents/${encodeURIComponent(id)}/tasks`, { input: { q: 1 } }, plaintext);
        expect(first.body).toMatchObject({ status: 'COMPLETED', paymentUsd: '0.050000' });
        expect(await spent(row.id)).toBe(parseUsd('0.05'));
        const second = await gw.post(`/n8n/v1/agents/${encodeURIComponent(id)}/tasks`, { input: { q: 2 } }, plaintext);
        expect(second.body.code).toBe('PAYMENT_CAP');
        expect(await spent(row.id)).toBe(parseUsd('0.05'));
        const got = await gw.get(`/n8n/v1/tasks/${first.body.taskId}`, plaintext);
        expect(got.body).toEqual(first.body);
      } finally {
        await remote.close();
        await gw.close();
      }
    });
  });
});

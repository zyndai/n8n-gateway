// M4 stores against real Postgres: listing edit/delete (M4.1), API keys (M4.2), task history (M4.9).
// Runs only with TEST_DATABASE_URL (migrations applied, developer_keys present).
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDb, getDb } from '../src/db/client.js';
import { developerKey } from '../src/db/dashboard.js';
import { n8nAgentWallet, n8nApiKey, n8nDerivationCounter, n8nHeartbeat, n8nListing, n8nTask } from '../src/db/schema.js';
import { hashApiKey } from '../src/middleware/apiKeyAuth.js';
import { ApiKeyService } from '../src/services/ApiKeyService.js';
import { AgentWalletStore } from '../src/services/AgentWalletStore.js';
import { ApiKeyStore } from '../src/services/ApiKeyStore.js';
import { ListingStore } from '../src/services/ListingStore.js';
import { TaskStore } from '../src/services/TaskStore.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('M4 on Postgres', () => {
  const A = `zns:dev:m4a-${randomUUID()}`;
  const B = `zns:dev:m4b-${randomUUID()}`;
  let listings: ListingStore;
  let keys: ApiKeyStore;
  let tasks: TaskStore;
  const input = { name: 'W', summary: 'S', category: 'general', tags: ['x'] };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const db = getDb();
    listings = new ListingStore(db);
    keys = new ApiKeyStore(db);
    tasks = new TaskStore(db);
    for (const d of [A, B]) {
      await db.insert(developerKey).values({ id: randomUUID(), userId: `u_${d}`, developerId: d, publicKey: '', privateKeyEnc: '', name: 'm4' });
    }
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(n8nTask).where(inArray(n8nTask.developerId, [A, B]));
    await db.delete(n8nAgentWallet).where(inArray(n8nAgentWallet.developerId, [A, B]));
    await db.delete(n8nApiKey).where(inArray(n8nApiKey.developerId, [A, B]));
    await db.delete(n8nListing).where(inArray(n8nListing.developerId, [A, B]));
    
    await db.delete(n8nDerivationCounter).where(inArray(n8nDerivationCounter.developerId, [A, B]));
    await db.delete(developerKey).where(inArray(developerKey.developerId, [A, B]));
    await disconnectDb();
  });

  it('updates only the owner’s listing and bumps updatedAt', async () => {
    const l = await listings.createListing(A, input);
    expect(await listings.update(B, l.id, { name: 'hijack' })).toBeUndefined();
    const row = await listings.update(A, l.id, { name: 'W2', tags: ['a', 'b'], workflowId: 'wf' });
    expect(row).toMatchObject({ name: 'W2', summary: 'S', tags: ['a', 'b'], workflowId: 'wf' });
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(l.updatedAt.getTime());
    expect((await listings.update(A, l.id, { workflowId: null }))!.workflowId).toBeNull();
  });

  it('delete cascades the heartbeat, keeps task history with a null listing, and never frees the derivation index', async () => {
    const l = await listings.createListing(A, input);
    await listings.record(l.id, { status: 'ACTIVE', lastBeatAt: new Date(), failCount: 0 });
    const t = await tasks.create({ developerId: A, listingId: l.id, direction: 'INBOUND', input: {} });

    expect(await listings.remove(B, l.id)).toBeUndefined();
    expect((await listings.remove(A, l.id))?.id).toBe(l.id);
    expect(await listings.getById(l.id)).toBeUndefined();
    expect(await getDb().select().from(n8nHeartbeat).where(eq(n8nHeartbeat.listingId, l.id))).toEqual([]);
    expect((await tasks.get(t.id))?.listingId).toBeNull();

    const next = await listings.createListing(A, input);
    expect(next.derivedKeyIndex).toBeGreaterThan(l.derivedKeyIndex);
  });

  it('creates, lists and revokes keys; the revoked key keeps its first timestamp', async () => {
    const svc = new ApiKeyService({ store: keys, developerExists: (d) => listings.developerExists(d) });
    const made = await svc.create(A, { name: 'k', spendCapUsd: '2.5', permissions: ['call'] });
    const stored = await keys.findByHash(hashApiKey(made.key));
    expect(stored).toMatchObject({ id: made.id, keyPrefix: made.key.slice(0, 8), spendCapUsd: '2.500000', permissions: ['call'], revokedAt: null });
    expect(stored!.keyHash).not.toBe(made.key);

    expect((await svc.list(A)).map((k) => k.id)).toEqual([made.id]);
    expect(await svc.list(B)).toEqual([]);
    await expect(svc.revoke(B, made.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const first = await svc.revoke(A, made.id);
    expect(first.revokedAt).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 10));
    expect((await svc.revoke(A, made.id)).revokedAt).toEqual(first.revokedAt);
    expect((await keys.findByHash(hashApiKey(made.key)))!.revokedAt).not.toBeNull();
  });

  it('rejects key creation for an unknown developer', async () => {
    const svc = new ApiKeyService({ store: keys, developerExists: (d) => listings.developerExists(d) });
    await expect(svc.create('zns:dev:ghost', { name: 'k' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('pages and filters task history newest first, scoped to the developer', async () => {
    const l = await listings.createListing(A, input);
    const ids: string[] = [];
    for (const [dev, dir, listingId] of [[A, 'INBOUND', l.id], [A, 'OUTBOUND', undefined], [A, 'INBOUND', l.id], [B, 'OUTBOUND', undefined]] as const) {
      ids.push((await tasks.create({ developerId: dev, direction: dir, listingId, input: {} })).id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const all = await tasks.listByDeveloper(A, { limit: 50, offset: 0 });
    const mine = all.filter((t) => ids.includes(t.id)).map((t) => t.id);
    expect(mine).toEqual([ids[2], ids[1], ids[0]]);
    expect(all.some((t) => t.id === ids[3])).toBe(false);
    expect((await tasks.listByDeveloper(A, { listingId: l.id, limit: 50, offset: 0 })).map((t) => t.id)).toEqual([ids[2], ids[0]]);
    expect((await tasks.listByDeveloper(A, { direction: 'OUTBOUND', limit: 1, offset: 0 })).map((t) => t.id)).toEqual([ids[1]]);
    expect((await tasks.listByDeveloper(A, { listingId: l.id, limit: 1, offset: 1 })).map((t) => t.id)).toEqual([ids[0]]);
  });

  it('M6.4: rotates a key in Postgres: copy with the spend so far, old key expires after the grace period', async () => {
    const svc = new ApiKeyService({ store: keys, developerExists: (d) => listings.developerExists(d) });
    const made = await svc.create(A, { name: 'rot', spendCapUsd: '5', permissions: ['search'] });
    expect(await keys.reserveSpend(made.id, 1_250_000n)).toBe(true);
    const { created, previous } = await svc.rotate(A, made.id, { graceHours: 1 });
    const fresh = await keys.findByHash(hashApiKey(created.key));
    expect(fresh).toMatchObject({ name: 'rot', permissions: ['search'], spendCapUsd: '5.000000', spentUsd: '1.250000', revokedAt: null });
    expect(previous.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(previous.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 61 * 60_000);
    await expect(svc.rotate(B, made.id, {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('M6.2: aggregates inbound calls per listing and UTC day', async () => {
    const l = await listings.createListing(A, input);
    const mk = async (status: 'COMPLETED' | 'FAILED' | 'TIMEOUT' | 'CANCELED', paid?: string, direction: 'INBOUND' | 'OUTBOUND' = 'INBOUND') => {
      const t = await tasks.create({ developerId: A, listingId: l.id, direction, input: {}, paymentUsd: paid ?? null });
      await tasks.transition(t.id, ['PENDING'], status, paid && status === 'COMPLETED' ? { paymentTxn: '0xtx' } : {});
      return t;
    };
    await mk('COMPLETED', '0.05');
    await mk('COMPLETED', '0.05');
    await mk('FAILED', '0.05');
    await mk('TIMEOUT');
    await mk('CANCELED');
    await mk('COMPLETED', '9', 'OUTBOUND');
    const old = await mk('COMPLETED', '0.01');
    await getDb().update(n8nTask).set({ createdAt: new Date(Date.now() - 5 * 86_400_000) }).where(eq(n8nTask.id, old.id));

    const rows = await tasks.analytics(A, { since: new Date(Date.now() - 30 * 86_400_000), listingId: l.id });
    expect(rows).toHaveLength(2);
    const today = new Date().toISOString().slice(0, 10);
    expect(rows.find((r) => r.day === today)).toEqual({ day: today, listingId: l.id, calls: 5, completed: 2, failed: 2, revenueUsd: '0.100000' });
    expect(rows[0]!.day < today).toBe(true);
    expect(rows[0]).toMatchObject({ calls: 1, completed: 1, failed: 0, revenueUsd: '0.010000' });
    expect(await tasks.analytics(B, { since: new Date(0) })).toEqual([]);
    expect(await tasks.analytics(A, { since: new Date(Date.now() - 86_400_000), listingId: 'nope' })).toEqual([]);
  });

  it('stores one wallet per listing, keeps the first of two racing writes, and survives the listing being deleted', async () => {
    const wallets = new AgentWalletStore(getDb());
    const l = await listings.createListing(A, input);
    const address = `0x${randomUUID().replace(/-/g, '').padEnd(40, '0')}`;
    const w = { listingId: l.id, developerId: A, derivedKeyIndex: l.derivedKeyIndex, address, privateKeyEnc: 'enc-1' };
    const [x, y] = await Promise.all([wallets.put(w), wallets.put({ ...w, privateKeyEnc: 'enc-2' })]);
    expect(x.id).toBe(y.id);
    expect((await wallets.getByListingIds([l.id])).get(l.id)).toMatchObject({ address, developerId: A });
    expect(await wallets.getByListingIds([])).toEqual(new Map());

    await listings.remove(A, l.id);
    // ON DELETE SET NULL: the key outlives the listing, detached from it.
    const [kept] = await getDb().select().from(n8nAgentWallet).where(eq(n8nAgentWallet.address, address));
    expect(kept).toMatchObject({ listingId: null, privateKeyEnc: x.privateKeyEnc });
  });
});

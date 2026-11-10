// M4 stores against real Postgres: listing edit/delete (M4.1), API keys (M4.2), task history (M4.9).
// Runs only with TEST_DATABASE_URL (migrations applied, developer_keys present).
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDb, getDb } from '../src/db/client.js';
import { developerKey } from '../src/db/dashboard.js';
import { n8nApiKey, n8nDerivationCounter, n8nHeartbeat, n8nListing, n8nTask } from '../src/db/schema.js';
import { hashApiKey } from '../src/middleware/apiKeyAuth.js';
import { ApiKeyService } from '../src/services/ApiKeyService.js';
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
});

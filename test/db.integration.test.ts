// Runs only when TEST_DATABASE_URL points at a database with the Gateway migrations applied
// and the dashboard's "developer_keys" table (see README). Skipped otherwise, so `npm test`
// needs no Postgres.
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { developerKey } from '../src/db/dashboard.js';
import { disconnectDb, getDb } from '../src/db/client.js';
import { n8nApiKey, n8nDerivationCounter, n8nListing, n8nNonce } from '../src/db/schema.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('database (Drizzle)', () => {
  const devId = `dev_${Date.now()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    await getDb()
      .insert(developerKey)
      .values({ id: randomUUID(), userId: `u_${devId}`, developerId: devId, publicKey: '', privateKeyEnc: 'x', name: 'test' });
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(n8nListing).where(eq(n8nListing.developerId, devId));
    await db.delete(n8nApiKey).where(eq(n8nApiKey.developerId, devId));
    await db.delete(n8nDerivationCounter).where(eq(n8nDerivationCounter.developerId, devId));
    await db.delete(developerKey).where(eq(developerKey.developerId, devId));
    await disconnectDb();
  });

  it('applies column defaults', async () => {
    const db = getDb();
    const [key] = await db
      .insert(n8nApiKey)
      .values({ developerId: devId, name: 'k', keyHash: `h_${devId}`, keyPrefix: 'zk_12345' })
      .returning();
    expect(key?.permissions).toEqual(['search', 'call', 'complete']);
    expect(Number(key?.spentUsd)).toBe(0);
    expect(key?.id).toMatch(/^[0-9a-f-]{36}$/);

    const [listing] = await db
      .insert(n8nListing)
      .values({ developerId: devId, name: 'a', summary: 's', category: 'c', tags: ['x'], derivedKeyIndex: 99 })
      .returning();
    expect(listing?.status).toBe('DRAFT');
  });

  it('enforces one derivedKeyIndex per developer (G13)', async () => {
    const dup = getDb()
      .insert(n8nListing)
      .values({ developerId: devId, name: 'b', summary: 's', category: 'c', tags: [], derivedKeyIndex: 99 });
    await expect(dup).rejects.toThrow();
  });

  it('allocates unique indexes under concurrency (G13)', async () => {
    const db = getDb();
    const alloc = async () => {
      const [row] = await db
        .insert(n8nDerivationCounter)
        .values({ developerId: devId, nextIndex: 1 })
        .onConflictDoUpdate({
          target: n8nDerivationCounter.developerId,
          set: { nextIndex: sql`${n8nDerivationCounter.nextIndex} + 1` },
        })
        .returning({ next: n8nDerivationCounter.nextIndex });
      return (row?.next ?? 0) - 1; // index handed out
    };
    const got = await Promise.all(Array.from({ length: 25 }, alloc));
    expect(new Set(got).size).toBe(25);
    expect([...got].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('rejects a replayed nonce atomically (G5)', async () => {
    const db = getDb();
    const nonce = `n_${devId}`;
    const expiresAt = new Date(Date.now() + 60_000);
    const first = await db.insert(n8nNonce).values({ nonce, expiresAt }).onConflictDoNothing().returning();
    const replay = await db.insert(n8nNonce).values({ nonce, expiresAt }).onConflictDoNothing().returning();
    expect(first).toHaveLength(1);
    expect(replay).toHaveLength(0);
    await db.delete(n8nNonce).where(eq(n8nNonce.nonce, nonce));
  });
});

// n8n API keys (LLD > N8nApiKey): lookup by SHA-256 hash, lastUsedAt, and the atomic spend
// counter behind spend caps (M2.16).
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { n8nApiKey } from '../db/schema.js';
import { formatUsd } from './money.js';

export type ApiKeyRow = typeof n8nApiKey.$inferSelect;

export interface NewApiKey {
  developerId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  permissions: string[];
  spendCapUsd: string | null;
  expiresAt: Date | null;
  /** M6.4: a rotated key inherits what its predecessor already spent, so rotating never resets a cap. */
  spentUsd?: string;
}

export interface ApiKeyStoreLike {
  findByHash(keyHash: string): Promise<ApiKeyRow | undefined>;
  touch(id: string, at: Date): Promise<void>;
  /** M4.2: store a new key (hash only). */
  create(key: NewApiKey): Promise<ApiKeyRow>;
  /** M4.2: the developer's keys, newest first, revoked ones included. */
  listByDeveloper(developerId: string): Promise<ApiKeyRow[]>;
  /** M6.4: one of the developer's keys; undefined if the developer does not own it. */
  get(developerId: string, id: string): Promise<ApiKeyRow | undefined>;
  /** M6.4: set when the key stops working. Undefined if the developer does not own it. */
  setExpiry(developerId: string, id: string, expiresAt: Date): Promise<ApiKeyRow | undefined>;
  /** M4.2: soft-delete. Keeps the original `revokedAt` if already revoked. Undefined if the developer does not own it. */
  revoke(developerId: string, id: string, at: Date): Promise<ApiKeyRow | undefined>;
  /**
   * Add `microUsd` to `spentUsd` only if it keeps the total within `spendCapUsd` (no cap = always).
   * One conditional UPDATE, so concurrent calls can never overshoot the cap. False if refused.
   */
  reserveSpend(id: string, microUsd: bigint): Promise<boolean>;
  /** Give back a reservation whose payment never left the Gateway. */
  refundSpend(id: string, microUsd: bigint): Promise<void>;
}

export class ApiKeyStore implements ApiKeyStoreLike {
  constructor(private readonly db: Db) {}

  async findByHash(keyHash: string) {
    const [row] = await this.db.select().from(n8nApiKey).where(eq(n8nApiKey.keyHash, keyHash)).limit(1);
    return row;
  }

  async create(key: NewApiKey) {
    const [row] = await this.db.insert(n8nApiKey).values(key).returning();
    if (!row) throw new Error('api key insert returned no row');
    return row;
  }

  async listByDeveloper(developerId: string) {
    return this.db.select().from(n8nApiKey).where(eq(n8nApiKey.developerId, developerId)).orderBy(desc(n8nApiKey.createdAt));
  }

  async get(developerId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(n8nApiKey)
      .where(and(eq(n8nApiKey.id, id), eq(n8nApiKey.developerId, developerId)))
      .limit(1);
    return row;
  }

  async setExpiry(developerId: string, id: string, expiresAt: Date) {
    const [row] = await this.db
      .update(n8nApiKey)
      .set({ expiresAt })
      .where(and(eq(n8nApiKey.id, id), eq(n8nApiKey.developerId, developerId)))
      .returning();
    return row;
  }

  async revoke(developerId: string, id: string, at: Date) {
    const [row] = await this.db
      .update(n8nApiKey)
      .set({ revokedAt: sql`COALESCE(${n8nApiKey.revokedAt}, ${at.toISOString()}::timestamp)` })
      .where(and(eq(n8nApiKey.id, id), eq(n8nApiKey.developerId, developerId)))
      .returning();
    return row;
  }

  async touch(id: string, at: Date) {
    await this.db.update(n8nApiKey).set({ lastUsedAt: at }).where(eq(n8nApiKey.id, id));
  }

  async reserveSpend(id: string, microUsd: bigint) {
    const amt = formatUsd(microUsd);
    const rows = await this.db
      .update(n8nApiKey)
      .set({ spentUsd: sql`${n8nApiKey.spentUsd} + ${amt}::numeric` })
      .where(
        and(
          eq(n8nApiKey.id, id),
          or(isNull(n8nApiKey.spendCapUsd), sql`${n8nApiKey.spentUsd} + ${amt}::numeric <= ${n8nApiKey.spendCapUsd}`),
        ),
      )
      .returning({ id: n8nApiKey.id });
    return rows.length > 0;
  }

  async refundSpend(id: string, microUsd: bigint) {
    const amt = formatUsd(microUsd);
    await this.db
      .update(n8nApiKey)
      .set({ spentUsd: sql`GREATEST(${n8nApiKey.spentUsd} - ${amt}::numeric, 0)` })
      .where(eq(n8nApiKey.id, id));
  }
}

// n8n API keys (LLD > N8nApiKey): lookup by SHA-256 hash, lastUsedAt, and the atomic spend
// counter behind spend caps (M2.16).
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { n8nApiKey } from '../db/schema.js';
import { formatUsd } from './money.js';

export type ApiKeyRow = typeof n8nApiKey.$inferSelect;

export interface ApiKeyStoreLike {
  findByHash(keyHash: string): Promise<ApiKeyRow | undefined>;
  touch(id: string, at: Date): Promise<void>;
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

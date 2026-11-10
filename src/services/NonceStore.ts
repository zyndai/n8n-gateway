// Replay protection for `x-zynd-auth` (G5): a nonce may be claimed exactly once while it is valid.
import { lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { n8nNonce } from '../db/schema.js';

export interface NonceStoreLike {
  /** True if the key was new (and is now claimed), false if it was already seen. Atomic. */
  claim(key: string, expiresAt: Date): Promise<boolean>;
  /** Delete expired rows; returns how many. */
  purgeExpired(now?: Date): Promise<number>;
}

export class NonceStore implements NonceStoreLike {
  constructor(private readonly db: Db) {}

  async claim(key: string, expiresAt: Date) {
    const rows = await this.db
      .insert(n8nNonce)
      .values({ nonce: key, expiresAt })
      .onConflictDoNothing({ target: n8nNonce.nonce })
      .returning({ nonce: n8nNonce.nonce });
    return rows.length > 0;
  }

  async purgeExpired(now: Date = new Date()) {
    const rows = await this.db.delete(n8nNonce).where(lt(n8nNonce.expiresAt, now)).returning({ nonce: n8nNonce.nonce });
    return rows.length;
  }
}

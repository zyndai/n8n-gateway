// The dashboard-owned `developer_keys` table, as far as POST /internal/v1/provision (Studio) needs
// it: find a developer by their Supabase user, add one, and give one a handle. Reading keys for
// signing stays in ListingStore. The dashboard's own code writes the same rows, so every write
// here is the narrowest one that does the job (insert-only, and a username set only while null).
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { developerKey } from '../db/dashboard.js';

export interface DeveloperRecord {
  userId: string;
  developerId: string;
  name: string;
  /** The handle, once claimed. Null while the developer has none. */
  username: string | null;
  /** `ed25519:<base64>` as the registry returned it; may be empty on very old rows. */
  publicKey: string;
  /** AES-256-GCM under PKI_ENCRYPTION_KEY, the same format the dashboard writes. */
  privateKeyEnc: string;
}

export type NewDeveloper = Omit<DeveloperRecord, 'username'>;

/** The Supabase user already has a developer row (two sign-ins raced, or the dashboard got there first). */
export class DuplicateDeveloperError extends Error {
  constructor() {
    super('developer already exists for this user');
    this.name = 'DuplicateDeveloperError';
  }
}

export interface DeveloperDirectory {
  findByUserId(userId: string): Promise<DeveloperRecord | undefined>;
  /** Insert a developer with no handle. Throws DuplicateDeveloperError when the user already has one. */
  insert(dev: NewDeveloper): Promise<DeveloperRecord>;
  usernameTaken(username: string): Promise<boolean>;
  /**
   * Set the handle only while the developer has none. `ok` = set; `taken` = another developer holds
   * that handle; `already_set` = this developer got a handle in the meantime (read them again).
   */
  setUsername(userId: string, username: string): Promise<'ok' | 'taken' | 'already_set'>;
}

const columns = {
  userId: developerKey.userId,
  developerId: developerKey.developerId,
  name: developerKey.name,
  username: developerKey.username,
  publicKey: developerKey.publicKey,
  privateKeyEnc: developerKey.privateKeyEnc,
};

/** postgres.js reports `code`; Drizzle may wrap it as `cause`. 23505 = unique_violation. */
function uniqueViolation(err: unknown): string | undefined {
  for (let e = err as { code?: string; constraint_name?: string; cause?: unknown } | undefined, i = 0; e && i < 3; e = e.cause as typeof e, i++) {
    if (e.code === '23505') return e.constraint_name ?? '';
  }
  return undefined;
}

export class DeveloperStore implements DeveloperDirectory {
  constructor(private readonly db: Db) {}

  async findByUserId(userId: string): Promise<DeveloperRecord | undefined> {
    const [row] = await this.db.select(columns).from(developerKey).where(eq(developerKey.userId, userId)).limit(1);
    return row;
  }

  async insert(dev: NewDeveloper): Promise<DeveloperRecord> {
    try {
      const [row] = await this.db.insert(developerKey).values({ id: randomUUID(), ...dev }).returning(columns);
      if (!row) throw new Error('developer insert returned no row');
      return row;
    } catch (err) {
      if (uniqueViolation(err) !== undefined) throw new DuplicateDeveloperError();
      throw err;
    }
  }

  async usernameTaken(username: string): Promise<boolean> {
    const [row] = await this.db.select({ id: developerKey.id }).from(developerKey).where(eq(developerKey.username, username)).limit(1);
    return row !== undefined;
  }

  async setUsername(userId: string, username: string): Promise<'ok' | 'taken' | 'already_set'> {
    try {
      const rows = await this.db
        .update(developerKey)
        .set({ username })
        .where(and(eq(developerKey.userId, userId), isNull(developerKey.username)))
        .returning({ id: developerKey.id });
      return rows.length > 0 ? 'ok' : 'already_set';
    } catch (err) {
      if (uniqueViolation(err) !== undefined) return 'taken';
      throw err;
    }
  }
}

// Persistence for agent wallets (n8n_agent_wallet). Gateway-owned table; the dashboard may read it
// but never migrates it.
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { n8nAgentWallet } from '../db/schema.js';

export type AgentWalletRow = typeof n8nAgentWallet.$inferSelect;
export type NewAgentWallet = Pick<AgentWalletRow, 'listingId' | 'developerId' | 'derivedKeyIndex' | 'address' | 'privateKeyEnc'>;

export interface AgentWalletStoreLike {
  /** Wallets for these listings, keyed by listing id. */
  getByListingIds(listingIds: string[]): Promise<Map<string, AgentWalletRow>>;
  /**
   * Insert, or keep the row a concurrent request already wrote (unique on listing, on
   * developer + derivation index and on address). Returns the row that is stored.
   */
  put(wallet: NewAgentWallet): Promise<AgentWalletRow>;
}

export class AgentWalletStore implements AgentWalletStoreLike {
  constructor(private readonly db: Db) {}

  async getByListingIds(listingIds: string[]): Promise<Map<string, AgentWalletRow>> {
    if (listingIds.length === 0) return new Map();
    const rows = await this.db.select().from(n8nAgentWallet).where(inArray(n8nAgentWallet.listingId, listingIds));
    return new Map(rows.flatMap((r) => (r.listingId ? [[r.listingId, r] as const] : [])));
  }

  async put(wallet: NewAgentWallet): Promise<AgentWalletRow> {
    await this.db.insert(n8nAgentWallet).values(wallet).onConflictDoNothing();
    const [row] = await this.db
      .select()
      .from(n8nAgentWallet)
      .where(eq(n8nAgentWallet.address, wallet.address))
      .limit(1);
    if (!row) throw new Error('agent wallet insert lost to a conflicting row');
    return row;
  }
}

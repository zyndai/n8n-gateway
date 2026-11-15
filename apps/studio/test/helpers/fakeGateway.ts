import { GatewayError, type DeveloperApi, type GatewayClient, type ListingPatch, type ListingTotals, type ListingView, type NewListingBody, type TaskView, type WalletView } from '@/lib/gateway/client';

/** An in-memory Gateway for one developer: listings, wallets, tasks and analytics. */
export class FakeGateway implements GatewayClient {
  listings: ListingView[] = [];
  tasks: TaskView[] = [];
  totals: ListingTotals[] = [];
  /** What `activateListing` leaves the listing as. */
  activateAs = 'ACTIVE';
  walletFails = false;
  calls: string[] = [];
  private n = 0;
  developers: string[] = [];

  provision(): never {
    throw new Error('not used here');
  }

  /** Add a listing straight to the store (as the dashboard, or another developer, might have). */
  seed(over: Partial<ListingView> = {}): ListingView {
    const l = this.make({ name: 'Seeded', summary: 's', category: 'general', tags: [] });
    Object.assign(l, over);
    this.listings.push(l);
    return l;
  }

  private make(b: NewListingBody): ListingView {
    this.n += 1;
    const now = new Date(1_800_000_000_000 + this.n * 1000).toISOString();
    return { id: `listing-${this.n}`, name: b.name, summary: b.summary, category: b.category, tags: b.tags, entityId: null, workflowId: b.workflowId ?? null, priceUsd: b.priceUsd ?? null, status: 'DRAFT', createdAt: now, updatedAt: now };
  }

  as(developerId: string): DeveloperApi {
    this.developers.push(developerId);
    const find = (id: string) => {
      const l = this.listings.find((x) => x.id === id);
      if (!l) throw new GatewayError('Listing not found', 404, 'NOT_FOUND');
      return l;
    };
    const log = <T>(s: string, v: T): T => (this.calls.push(s), v);
    return {
      listListings: async () => this.listings.map((l) => ({ ...l })),
      getListing: async (id) => ({ ...find(id) }),
      createListing: async (b) => {
        const l = this.make(b);
        this.listings.push(l);
        return log(`create ${l.id}`, { ...l });
      },
      updateListing: async (id, p: ListingPatch) => {
        const l = find(id);
        Object.assign(l, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
        return log(`update ${id} ${Object.keys(p).join(',')}`, { ...l });
      },
      deleteListing: async (id) => {
        find(id);
        this.listings = this.listings.filter((l) => l.id !== id);
        return log(`delete ${id}`, { id, deleted: true });
      },
      activateListing: async (id) => {
        const l = find(id);
        l.status = this.activateAs;
        return log(`activate ${id}`, { ...l });
      },
      deactivateListing: async (id) => {
        const l = find(id);
        if (l.status === 'DRAFT') throw new GatewayError('Cannot deactivate a DRAFT listing', 409, 'CONFLICT');
        l.status = 'INACTIVE';
        return log(`deactivate ${id}`, { ...l });
      },
      listTasks: async (q) => this.tasks.filter((t) => !q.listingId || t.listingId === q.listingId),
      analytics: async () => this.totals,
      wallet: async (): Promise<WalletView> => {
        if (this.walletFails) throw new GatewayError('chain down', 502, 'GATEWAY_UNAVAILABLE');
        return { payer: '0x90eba483ad984DeC6F0416e23fe68F138a015583', payerBalanceUsd: '0', listings: this.listings.map((l, i) => ({ listingId: l.id, name: l.name, address: `0x${(i + 1).toString(16).padStart(40, '0')}`, balanceUsd: '0' })) };
      },
      listApiKeys: async () => [],
      createApiKey: async () => Promise.reject(new Error('not used')),
      rotateApiKey: async () => Promise.reject(new Error('not used')),
      revokeApiKey: async () => ({}),
    };
  }
}

// Drizzle-backed persistence for listings, the derivation allocator and heartbeat rows.
// Kept apart from ListingService so the service logic is testable without a database.
import { and, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { developerKey } from '../db/dashboard.js';
import { n8nDerivationCounter, n8nHeartbeat, n8nListing } from '../db/schema.js';
import type { DeveloperKeyRecord, DeveloperKeySource } from './IdentityService.js';
import type { HeartbeatPatch, HeartbeatStore, ResumeTarget } from './HeartbeatManager.js';
import { REGISTERING_STALE_MS, allowedFrom, type ListingStatus } from './listingState.js';

export type ListingRow = typeof n8nListing.$inferSelect;
export type HeartbeatRow = typeof n8nHeartbeat.$inferSelect;

export interface NewListing {
  name: string;
  summary: string;
  category: string;
  tags: string[];
  workflowId?: string;
  /** Decimal USD per inbound call; undefined = Gateway default. */
  priceUsd?: string;
}

export interface ListingStoreLike extends DeveloperKeySource, HeartbeatStore {
  developerExists(developerId: string): Promise<boolean>;
  createListing(developerId: string, input: NewListing): Promise<ListingRow>;
  getOwned(developerId: string, listingId: string): Promise<{ listing: ListingRow; heartbeat: HeartbeatRow | null } | undefined>;
  listByDeveloper(developerId: string): Promise<{ listing: ListingRow; heartbeat: HeartbeatRow | null }[]>;
  /** Compare-and-set `to` from any state the machine allows; undefined if the listing was not in one. */
  transition(listingId: string, to: ListingStatus, patch?: Partial<Pick<ListingRow, 'entityId'>>): Promise<ListingRow | undefined>;
  /** Claim a stale REGISTERING listing (previous attempt died) for a fresh registration attempt. */
  claimStaleRegistration(listingId: string, now?: Date): Promise<ListingRow | undefined>;
  loadActive(requireWebhook: boolean): Promise<ResumeTarget[]>;
  /** Lookup by AgentDNS entity id, any developer (inbound A2A has no developer context). */
  getByEntityId(entityId: string): Promise<ListingRow | undefined>;
  getById(listingId: string): Promise<ListingRow | undefined>;
  /** M2.5: bind (or, with null, clear) the n8n webhook. Undefined if the developer does not own the listing. */
  setWebhook(developerId: string, listingId: string, webhook: { url: string; secretEnc: string } | null): Promise<ListingRow | undefined>;
  /** G17: set (or, with null, reset to the Gateway default) the listing's inbound price. Undefined if not owned. */
  setPrice(developerId: string, listingId: string, priceUsd: string | null): Promise<ListingRow | undefined>;
  /** The developer's listings bound to exactly `url` (webhook `checkExists`). */
  findByWebhookUrl(developerId: string, url: string): Promise<ListingRow[]>;
}

export class ListingStore implements ListingStoreLike {
  constructor(private readonly db: Db) {}

  async getDeveloperKey(developerId: string): Promise<DeveloperKeyRecord | undefined> {
    const [row] = await this.db
      .select({ privateKeyEnc: developerKey.privateKeyEnc, publicKey: developerKey.publicKey })
      .from(developerKey)
      .where(eq(developerKey.developerId, developerId))
      .limit(1);
    return row;
  }

  async developerExists(developerId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: developerKey.id })
      .from(developerKey)
      .where(eq(developerKey.developerId, developerId))
      .limit(1);
    return row !== undefined;
  }

  /**
   * M1.2 / G13: allocate the next derivedKeyIndex and insert the listing in one transaction.
   * The counter upsert takes a row lock, so concurrent creates for a developer serialise and
   * never share an index; the unique(developerId, derivedKeyIndex) index is the backstop.
   * A rolled-back insert burns its index, which is fine: indexes only need to be unique.
   */
  async createListing(developerId: string, input: NewListing): Promise<ListingRow> {
    return this.db.transaction(async (tx) => {
      const [counter] = await tx
        .insert(n8nDerivationCounter)
        .values({ developerId, nextIndex: 1 })
        .onConflictDoUpdate({
          target: n8nDerivationCounter.developerId,
          set: { nextIndex: sql`${n8nDerivationCounter.nextIndex} + 1` },
        })
        .returning({ next: n8nDerivationCounter.nextIndex });
      if (!counter) throw new Error('derivation counter upsert returned no row');
      const [row] = await tx
        .insert(n8nListing)
        .values({
          developerId,
          name: input.name,
          summary: input.summary,
          category: input.category,
          tags: input.tags,
          workflowId: input.workflowId ?? null,
          priceUsd: input.priceUsd ?? null,
          derivedKeyIndex: counter.next - 1,
        })
        .returning();
      if (!row) throw new Error('listing insert returned no row');
      return row;
    });
  }

  async getOwned(developerId: string, listingId: string) {
    const [row] = await this.db
      .select({ listing: n8nListing, heartbeat: n8nHeartbeat })
      .from(n8nListing)
      .leftJoin(n8nHeartbeat, eq(n8nHeartbeat.listingId, n8nListing.id))
      .where(and(eq(n8nListing.id, listingId), eq(n8nListing.developerId, developerId)))
      .limit(1);
    return row;
  }

  async listByDeveloper(developerId: string) {
    return this.db
      .select({ listing: n8nListing, heartbeat: n8nHeartbeat })
      .from(n8nListing)
      .leftJoin(n8nHeartbeat, eq(n8nHeartbeat.listingId, n8nListing.id))
      .where(eq(n8nListing.developerId, developerId))
      .orderBy(desc(n8nListing.createdAt));
  }

  async transition(listingId: string, to: ListingStatus, patch: Partial<Pick<ListingRow, 'entityId'>> = {}) {
    const [row] = await this.db
      .update(n8nListing)
      .set({ status: to, ...patch })
      .where(and(eq(n8nListing.id, listingId), inArray(n8nListing.status, allowedFrom(to))))
      .returning();
    return row;
  }

  async claimStaleRegistration(listingId: string, now: Date = new Date()) {
    const [row] = await this.db
      .update(n8nListing)
      .set({ status: 'REGISTERING' })
      .where(
        and(
          eq(n8nListing.id, listingId),
          eq(n8nListing.status, 'REGISTERING'),
          lt(n8nListing.updatedAt, new Date(now.getTime() - REGISTERING_STALE_MS)),
        ),
      )
      .returning();
    return row;
  }

  async loadActive(requireWebhook: boolean): Promise<ResumeTarget[]> {
    const rows = await this.db
      .select({
        listingId: n8nListing.id,
        developerId: n8nListing.developerId,
        derivedKeyIndex: n8nListing.derivedKeyIndex,
        entityId: n8nListing.entityId,
      })
      .from(n8nListing)
      .where(
        and(
          eq(n8nListing.status, 'ACTIVE'),
          isNotNull(n8nListing.entityId),
          requireWebhook ? isNotNull(n8nListing.webhookUrl) : undefined,
        ),
      );
    return rows.flatMap((r) => (r.entityId ? [{ ...r, entityId: r.entityId }] : []));
  }

  async getByEntityId(entityId: string) {
    const [row] = await this.db.select().from(n8nListing).where(eq(n8nListing.entityId, entityId)).limit(1);
    return row;
  }

  async getById(listingId: string) {
    const [row] = await this.db.select().from(n8nListing).where(eq(n8nListing.id, listingId)).limit(1);
    return row;
  }

  async setWebhook(developerId: string, listingId: string, webhook: { url: string; secretEnc: string } | null) {
    const [row] = await this.db
      .update(n8nListing)
      .set({ webhookUrl: webhook?.url ?? null, webhookSecretEnc: webhook?.secretEnc ?? null })
      .where(and(eq(n8nListing.id, listingId), eq(n8nListing.developerId, developerId)))
      .returning();
    return row;
  }

  async setPrice(developerId: string, listingId: string, priceUsd: string | null) {
    const [row] = await this.db
      .update(n8nListing)
      .set({ priceUsd })
      .where(and(eq(n8nListing.id, listingId), eq(n8nListing.developerId, developerId)))
      .returning();
    return row;
  }

  async findByWebhookUrl(developerId: string, url: string) {
    return this.db
      .select()
      .from(n8nListing)
      .where(and(eq(n8nListing.developerId, developerId), eq(n8nListing.webhookUrl, url)));
  }

  /** HeartbeatStore: one row per listing, upserted. */
  async record(listingId: string, patch: HeartbeatPatch): Promise<void> {
    const set = {
      status: patch.status,
      updatedAt: new Date(), // $onUpdate does not apply to ON CONFLICT DO UPDATE
      ...(patch.lastBeatAt ? { lastBeatAt: patch.lastBeatAt } : {}),
      ...(patch.failCount !== undefined ? { failCount: patch.failCount } : {}),
    };
    await this.db
      .insert(n8nHeartbeat)
      .values({ listingId, ...set })
      .onConflictDoUpdate({ target: n8nHeartbeat.listingId, set });
  }
}

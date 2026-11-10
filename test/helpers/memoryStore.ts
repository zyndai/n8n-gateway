// In-memory ListingStoreLike with the same compare-and-set semantics as the Drizzle store.
import { randomUUID } from 'node:crypto';
import type { DeveloperKeyRecord } from '../../src/services/IdentityService.js';
import type { HeartbeatPatch } from '../../src/services/HeartbeatManager.js';
import type { HeartbeatRow, ListingRow, ListingStoreLike, NewListing } from '../../src/services/ListingStore.js';
import { REGISTERING_STALE_MS, allowedFrom, type ListingStatus } from '../../src/services/listingState.js';

export class MemoryStore implements ListingStoreLike {
  listings = new Map<string, ListingRow>();
  heartbeats = new Map<string, HeartbeatRow>();
  counters = new Map<string, number>();
  keys = new Map<string, DeveloperKeyRecord>();

  async getDeveloperKey(id: string) {
    return this.keys.get(id);
  }
  async developerExists(id: string) {
    return this.keys.has(id);
  }
  async createListing(developerId: string, input: NewListing): Promise<ListingRow> {
    const idx = this.counters.get(developerId) ?? 0;
    this.counters.set(developerId, idx + 1);
    const now = new Date();
    const row: ListingRow = {
      id: randomUUID(),
      developerId,
      name: input.name,
      summary: input.summary,
      category: input.category,
      tags: input.tags,
      entityId: null,
      derivedKeyIndex: idx,
      webhookUrl: null,
      webhookSecretEnc: null,
      workflowId: input.workflowId ?? null,
      priceUsd: input.priceUsd ?? null,
      status: 'DRAFT',
      createdAt: now,
      updatedAt: now,
    };
    this.listings.set(row.id, row);
    return row;
  }
  async getOwned(developerId: string, listingId: string) {
    const listing = this.listings.get(listingId);
    if (!listing || listing.developerId !== developerId) return undefined;
    return { listing, heartbeat: this.heartbeats.get(listingId) ?? null };
  }
  async listByDeveloper(developerId: string) {
    return [...this.listings.values()]
      .filter((l) => l.developerId === developerId)
      .map((listing) => ({ listing, heartbeat: this.heartbeats.get(listing.id) ?? null }));
  }
  async transition(listingId: string, to: ListingStatus, patch: Partial<Pick<ListingRow, 'entityId'>> = {}) {
    const l = this.listings.get(listingId);
    if (!l || !allowedFrom(to).includes(l.status)) return undefined;
    const next = { ...l, ...patch, status: to, updatedAt: new Date() };
    this.listings.set(listingId, next);
    return next;
  }
  async claimStaleRegistration(listingId: string, now = new Date()) {
    const l = this.listings.get(listingId);
    if (!l || l.status !== 'REGISTERING' || l.updatedAt.getTime() > now.getTime() - REGISTERING_STALE_MS) return undefined;
    const next = { ...l, updatedAt: now };
    this.listings.set(listingId, next);
    return next;
  }
  async loadActive(requireWebhook: boolean) {
    return [...this.listings.values()]
      .filter((l) => l.status === 'ACTIVE' && l.entityId && (!requireWebhook || l.webhookUrl))
      .map((l) => ({ listingId: l.id, developerId: l.developerId, derivedKeyIndex: l.derivedKeyIndex, entityId: l.entityId as string }));
  }
  async getByEntityId(entityId: string) {
    return [...this.listings.values()].find((l) => l.entityId === entityId);
  }
  async getById(listingId: string) {
    return this.listings.get(listingId);
  }
  async setWebhook(developerId: string, listingId: string, webhook: { url: string; secretEnc: string } | null) {
    const l = this.listings.get(listingId);
    if (!l || l.developerId !== developerId) return undefined;
    const next = { ...l, webhookUrl: webhook?.url ?? null, webhookSecretEnc: webhook?.secretEnc ?? null, updatedAt: new Date() };
    this.listings.set(listingId, next);
    return next;
  }
  async setPrice(developerId: string, listingId: string, priceUsd: string | null) {
    const l = this.listings.get(listingId);
    if (!l || l.developerId !== developerId) return undefined;
    const next = { ...l, priceUsd, updatedAt: new Date() };
    this.listings.set(listingId, next);
    return next;
  }
  async findByWebhookUrl(developerId: string, url: string) {
    return [...this.listings.values()].filter((l) => l.developerId === developerId && l.webhookUrl === url);
  }
  async record(listingId: string, patch: HeartbeatPatch) {
    const prev = this.heartbeats.get(listingId);
    const now = new Date();
    this.heartbeats.set(listingId, {
      id: prev?.id ?? randomUUID(),
      listingId,
      status: patch.status,
      lastBeatAt: patch.lastBeatAt ?? prev?.lastBeatAt ?? null,
      failCount: patch.failCount ?? prev?.failCount ?? 0,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
  }
  /** Test helper: overwrite fields of a stored listing. */
  patch(listingId: string, fields: Partial<ListingRow>) {
    const l = this.listings.get(listingId);
    if (!l) throw new Error(`no listing ${listingId}`);
    const next = { ...l, ...fields };
    this.listings.set(listingId, next);
    return next;
  }
  /** Test helper: age a listing so it looks abandoned. */
  age(listingId: string, ms: number) {
    const l = this.listings.get(listingId);
    if (l) this.listings.set(listingId, { ...l, updatedAt: new Date(Date.now() - ms) });
  }
}

// Listing lifecycle (M1.2, M1.6-M1.8): create -> register on AgentDNS -> heartbeat.
// Implements HLD flow 3 (Listing activation).
import { ApiError } from '../errors.js';
import { AgentDnsClient, AgentDnsError, toGatewayError, type RegisterEntityBody } from './AgentDnsClient.js';
import type { HeartbeatManager } from './HeartbeatManager.js';
import { entityIdFor, publicKeyString, type IdentityService } from './IdentityService.js';
import type { HeartbeatRow, ListingRow, ListingStoreLike, NewListing } from './ListingStore.js';

export interface ListingView {
  id: string;
  name: string;
  summary: string;
  category: string;
  tags: string[];
  entityId: string | null;
  entityUrl: string | null;
  derivedKeyIndex: number;
  webhookUrl: string | null;
  workflowId: string | null;
  status: ListingRow['status'];
  createdAt: Date;
  updatedAt: Date;
  heartbeat: { status: HeartbeatRow['status']; lastBeatAt: Date | null; failCount: number } | null;
}

export interface ListingServiceDeps {
  store: ListingStoreLike;
  identity: IdentityService;
  agentDns: Pick<AgentDnsClient, 'registerEntity' | 'getEntity'>;
  heartbeats: Pick<HeartbeatManager, 'start' | 'stop'>;
  publicUrl: string;
  /** G7: heartbeat only once a webhook is bound. */
  heartbeatRequiresWebhook: boolean;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export class ListingService {
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;

  constructor(private readonly deps: ListingServiceDeps) {
    this.log = deps.log ?? console;
  }

  entityUrl(entityId: string): string {
    return `${this.deps.publicUrl}/a/${entityId}`;
  }

  async create(developerId: string, input: NewListing): Promise<ListingView> {
    if (!(await this.deps.store.developerExists(developerId))) throw new ApiError('NOT_FOUND', 'Developer not found');
    return this.view(await this.deps.store.createListing(developerId, input), null);
  }

  async list(developerId: string): Promise<ListingView[]> {
    return (await this.deps.store.listByDeveloper(developerId)).map((r) => this.view(r.listing, r.heartbeat));
  }

  async get(developerId: string, listingId: string): Promise<ListingView> {
    const r = await this.owned(developerId, listingId);
    return this.view(r.listing, r.heartbeat);
  }

  /**
   * Activate a listing. Idempotent: DRAFT / ERROR / unregistered INACTIVE register on AgentDNS;
   * a registered INACTIVE listing flips straight back to ACTIVE; an ACTIVE one just makes sure
   * its heartbeat is running.
   */
  async activate(developerId: string, listingId: string): Promise<ListingView> {
    const { listing } = await this.owned(developerId, listingId);
    const { store } = this.deps;

    let active: ListingRow;
    if (listing.status === 'ACTIVE') {
      active = listing;
    } else if (listing.status === 'INACTIVE' && listing.entityId) {
      const row = await store.transition(listing.id, 'ACTIVE');
      if (!row) throw new ApiError('CONFLICT', 'Listing changed state during activation; retry');
      active = row;
    } else {
      active = await this.register(listing);
    }

    this.ensureHeartbeat(active);
    return this.get(developerId, listingId);
  }

  /** ACTIVE (or ERROR) -> INACTIVE: stop the heartbeat and drop the cached keypair. */
  async deactivate(developerId: string, listingId: string): Promise<ListingView> {
    const { listing } = await this.owned(developerId, listingId);
    if (listing.status === 'ACTIVE' || listing.status === 'ERROR') {
      const row = await this.deps.store.transition(listing.id, 'INACTIVE');
      if (!row) throw new ApiError('CONFLICT', 'Listing changed state during deactivation; retry');
    } else if (listing.status !== 'INACTIVE') {
      throw new ApiError('CONFLICT', `Cannot deactivate a ${listing.status} listing`);
    }
    if (listing.entityId) await this.deps.heartbeats.stop(listing.entityId);
    this.deps.identity.invalidate(listing.id);
    return this.get(developerId, listingId);
  }

  /** Start the heartbeat if the listing is ACTIVE and (per G7) has a webhook. Safe to call repeatedly. */
  ensureHeartbeat(listing: ListingRow): void {
    if (listing.status !== 'ACTIVE' || !listing.entityId) return;
    if (this.deps.heartbeatRequiresWebhook && !listing.webhookUrl) return;
    const entityId = listing.entityId;
    void this.deps.identity
      .getListingKeypair({ listingId: listing.id, developerId: listing.developerId, derivedKeyIndex: listing.derivedKeyIndex })
      .then((keypair) => this.deps.heartbeats.start({ listingId: listing.id, entityId, keypair }))
      .catch((err: unknown) => this.log.error(`heartbeat start failed for listing ${listing.id}: ${(err as Error).message}`));
  }

  // --- registration (HLD flow 3, steps 1-4) -------------------------------------------------

  private async register(listing: ListingRow): Promise<ListingRow> {
    const { store, identity } = this.deps;

    const claimed =
      listing.status === 'REGISTERING'
        ? await store.claimStaleRegistration(listing.id)
        : await store.transition(listing.id, 'REGISTERING');
    if (!claimed) throw new ApiError('CONFLICT', 'Registration already in progress');

    try {
      const ref = { listingId: listing.id, developerId: listing.developerId, derivedKeyIndex: listing.derivedKeyIndex };
      const agent = await identity.getListingKeypair(ref);
      const entityId = entityIdFor(agent.publicKey);
      const entity = {
        name: listing.name,
        entity_url: this.entityUrl(entityId),
        category: listing.category,
        summary: listing.summary,
        tags: listing.tags,
      };
      const signed = identity.signRegistration(agent, entity);
      const proof = await identity.withDeveloperKeypair(listing.developerId, (dev) =>
        identity.createDerivationProof(dev, agent, listing.derivedKeyIndex),
      );
      const body: RegisterEntityBody = {
        ...entity,
        public_key: publicKeyString(agent.publicKey),
        signature: signed.signature,
        developer_id: listing.developerId,
        developer_proof: proof,
      };

      const registeredId = await this.registerIdempotent(body, entityId);
      if (registeredId !== entityId) {
        throw new ApiError('INTERNAL', 'AgentDNS assigned an unexpected entity id', { expected: entityId, got: registeredId });
      }

      const active = await store.transition(listing.id, 'ACTIVE', { entityId });
      if (!active) throw new ApiError('CONFLICT', 'Listing changed state during registration');
      this.log.info(`listing ${listing.id} registered as ${entityId}`);
      return active;
    } catch (err) {
      await store.transition(listing.id, 'ERROR').catch(() => undefined);
      this.log.error(`registration failed for listing ${listing.id}: ${(err as Error).message}`);
      throw toGatewayError(err);
    }
  }

  /**
   * POST /v1/entities. A 409 means a previous attempt registered the entity but we died before
   * recording it; that is success if the registry's record carries our public key.
   */
  private async registerIdempotent(body: RegisterEntityBody, entityId: string): Promise<string> {
    const { agentDns } = this.deps;
    try {
      return await agentDns.registerEntity(body);
    } catch (err) {
      if (!(err instanceof AgentDnsError) || err.status !== 409) throw err;
      const existing = await agentDns.getEntity(entityId);
      const same = (k?: string): string => (k ?? '').replace(/^ed25519:/, '');
      if (existing && same(existing.public_key) === same(body.public_key)) return entityId;
      throw err;
    }
  }

  // --- helpers ------------------------------------------------------------------------------

  private async owned(developerId: string, listingId: string) {
    const r = await this.deps.store.getOwned(developerId, listingId);
    // 404 (not 403) for someone else's listing, so ids cannot be probed.
    if (!r) throw new ApiError('NOT_FOUND', 'Listing not found');
    return r;
  }

  private view(l: ListingRow, hb: HeartbeatRow | null): ListingView {
    return {
      id: l.id,
      name: l.name,
      summary: l.summary,
      category: l.category,
      tags: l.tags,
      entityId: l.entityId,
      entityUrl: l.entityId ? this.entityUrl(l.entityId) : null,
      derivedKeyIndex: l.derivedKeyIndex,
      webhookUrl: l.webhookUrl,
      workflowId: l.workflowId,
      status: l.status,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      heartbeat: hb ? { status: hb.status, lastBeatAt: hb.lastBeatAt, failCount: hb.failCount } : null,
    };
  }
}

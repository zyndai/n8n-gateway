// Listing lifecycle (M1.2, M1.6-M1.8): create -> register on AgentDNS -> heartbeat.
// Implements HLD flow 3 (Listing activation).
import { ApiError } from '../errors.js';
import { decryptSecret, encryptSecret } from './keyVault.js';
import { parseUsd } from './money.js';
import { assertWebhookUrl } from './webhookUrl.js';
import { AgentDnsClient, AgentDnsError, toGatewayError, type RegisterEntityBody } from './AgentDnsClient.js';
import type { HeartbeatManager } from './HeartbeatManager.js';
import { entityIdFor, publicKeyString, type IdentityService } from './IdentityService.js';
import type { HeartbeatRow, ListingPatch, ListingRow, ListingStoreLike, NewListing } from './ListingStore.js';

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
  /** Own price per inbound call in USD, or null when the Gateway default applies. */
  priceUsd: string | null;
  status: ListingRow['status'];
  createdAt: Date;
  updatedAt: Date;
  heartbeat: { status: HeartbeatRow['status']; lastBeatAt: Date | null; failCount: number } | null;
}

export interface ListingUpdate extends ListingPatch {
  /** Decimal USD per inbound call; null resets to the Gateway default (G17). */
  priceUsd?: string | null;
}

export interface ListingServiceDeps {
  store: ListingStoreLike;
  identity: IdentityService;
  agentDns: Pick<AgentDnsClient, 'registerEntity' | 'getEntity'>;
  heartbeats: Pick<HeartbeatManager, 'start' | 'stop'>;
  publicUrl: string;
  /** G7: heartbeat only once a webhook is bound. */
  heartbeatRequiresWebhook: boolean;
  /** Encrypts webhook secrets at rest (G1). Required for webhook binding and forwarding. */
  masterKey?: Buffer;
  allowPrivateWebhooks?: boolean;
  /** Runs right after a listing is created: stores the agent's wallet. Best effort; the wallet view repairs a miss. */
  onCreated?: (listing: ListingRow) => Promise<unknown>;
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
    if (input.priceUsd !== undefined) parseUsd(input.priceUsd, 'priceUsd');
    if (!(await this.deps.store.developerExists(developerId))) throw new ApiError('NOT_FOUND', 'Developer not found');
    const row = await this.deps.store.createListing(developerId, input);
    if (this.deps.onCreated) {
      try {
        await this.deps.onCreated(row);
      } catch (e) {
        this.log.warn(`agent wallet for listing ${row.id} not stored yet: ${(e as Error).message}`);
      }
    }
    return this.view(row, null);
  }

  /** G17: set the listing's own price per inbound call ("0" = free), or null to use the Gateway default. */
  async setPrice(developerId: string, listingId: string, priceUsd: string | null): Promise<ListingView> {
    if (priceUsd !== null) parseUsd(priceUsd, 'priceUsd');
    const row = await this.deps.store.setPrice(developerId, listingId, priceUsd);
    if (!row) throw new ApiError('NOT_FOUND', 'Listing not found');
    return this.get(developerId, listingId);
  }

  /**
   * M4.1: edit name, summary, tags, workflow id and price. The Gateway's record and the signed
   * agent card change at once; the AgentDNS copy keeps the values it was registered with
   * (the registry client has no update call yet).
   */
  async update(developerId: string, listingId: string, patch: ListingUpdate): Promise<ListingView> {
    if (patch.priceUsd !== undefined && patch.priceUsd !== null) parseUsd(patch.priceUsd, 'priceUsd');
    await this.owned(developerId, listingId);
    const { priceUsd, ...fields } = patch;
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as ListingPatch;
    if (Object.keys(defined).length > 0) {
      if (!(await this.deps.store.update(developerId, listingId, defined))) throw new ApiError('NOT_FOUND', 'Listing not found');
    }
    if (priceUsd !== undefined) await this.deps.store.setPrice(developerId, listingId, priceUsd);
    return this.get(developerId, listingId);
  }

  /** M4.1: stop the heartbeat, forget the keypair and delete the listing. Its tasks stay as history. */
  async remove(developerId: string, listingId: string): Promise<{ id: string; deleted: true }> {
    const { listing } = await this.owned(developerId, listingId);
    if (listing.entityId) await this.deps.heartbeats.stop(listing.entityId);
    this.deps.identity.invalidate(listing.id);
    if (!(await this.deps.store.remove(developerId, listingId))) throw new ApiError('NOT_FOUND', 'Listing not found');
    return { id: listingId, deleted: true };
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

  // --- webhooks (M2.5, HLD flow 5). G14: a webhook is identified by its listing id. -----------

  /**
   * Bind the n8n webhook to a listing (ZyndTrigger `create`). A DRAFT or ERROR listing is
   * registered on AgentDNS first, so activating the workflow is enough to go live; an ACTIVE one
   * starts beating. An INACTIVE listing stays inactive: the developer turned it off on purpose.
   */
  async bindWebhook(developerId: string, listingId: string, input: { url: unknown; secret: unknown }): Promise<ListingView> {
    const masterKey = this.deps.masterKey;
    if (!masterKey) throw new ApiError('INTERNAL', 'Webhook binding is not configured');
    const url = assertWebhookUrl(input.url, { allowPrivate: this.deps.allowPrivateWebhooks ?? false });
    if (typeof input.secret !== 'string' || input.secret.length < 8 || input.secret.length > 256) {
      throw new ApiError('BAD_REQUEST', 'secret must be a string of 8 to 256 characters');
    }
    await this.owned(developerId, listingId);
    const bound = await this.deps.store.setWebhook(developerId, listingId, { url, secretEnc: encryptSecret(input.secret, masterKey) });
    if (!bound) throw new ApiError('NOT_FOUND', 'Listing not found');

    if (bound.status === 'DRAFT' || bound.status === 'ERROR') return this.activate(developerId, listingId);
    this.ensureHeartbeat(bound);
    return this.get(developerId, listingId);
  }

  /** ZyndTrigger `delete`: forget the webhook and stop beating. AgentDNS marks the agent inactive after 300 s. */
  async unbindWebhook(developerId: string, listingId: string): Promise<ListingView> {
    const { listing } = await this.owned(developerId, listingId);
    await this.deps.store.setWebhook(developerId, listingId, null);
    if (this.deps.heartbeatRequiresWebhook && listing.entityId) await this.deps.heartbeats.stop(listing.entityId);
    return this.get(developerId, listingId);
  }

  /** ZyndTrigger `checkExists`: the developer's listings bound to exactly this URL. */
  async findWebhooks(developerId: string, url: string): Promise<ListingView[]> {
    const rows = await this.deps.store.findByWebhookUrl(developerId, url);
    return Promise.all(rows.map((r) => this.get(developerId, r.id)));
  }

  /** The decrypted webhook target of a listing, or undefined when none is bound. */
  webhookTarget(listing: ListingRow): { url: string; secret: string } | undefined {
    const { masterKey } = this.deps;
    if (!masterKey || !listing.webhookUrl || !listing.webhookSecretEnc) return undefined;
    return { url: listing.webhookUrl, secret: decryptSecret(listing.webhookSecretEnc, masterKey) };
  }

  getByEntityId(entityId: string): Promise<ListingRow | undefined> {
    return this.deps.store.getByEntityId(entityId);
  }

  getById(listingId: string): Promise<ListingRow | undefined> {
    return this.deps.store.getById(listingId);
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
      priceUsd: l.priceUsd,
      status: l.status,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      heartbeat: hb ? { status: hb.status, lastBeatAt: hb.lastBeatAt, failCount: hb.failCount } : null,
    };
  }
}

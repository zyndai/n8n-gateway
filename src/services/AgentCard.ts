// G20 / M2.19: the A2A Agent Card for a listing, served at `{entity_url}/.well-known/agent-card.json`.
// SDK clients (`A2AClient.ask`, `resolveTransport`) append that path to a registry entity's
// `entity_url`, read the card's `url` and `preferredTransport`, and call that endpoint. The shape
// and the detached JWS follow zyndai-ts-sdk `a2a/card.ts` (JCS-canonical body, EdDSA, kid = public key).
import { ed25519 } from '@noble/curves/ed25519.js';
import { ApiError } from '../errors.js';
import { canonicalJson } from './canonical.js';
import { publicKeyString, type DerivationProof, type Ed25519Keypair, type IdentityService } from './IdentityService.js';
import type { ListingRow } from './ListingStore.js';
import { effectivePriceUsd } from './money.js';
import type { PaymentProcessor } from './PaymentProcessor.js';

export const CARD_PROTOCOL_VERSION = '0.3.0';
export const CARD_VERSION = '1.0.0';

export interface AgentCardServiceDeps {
  listings: { getByEntityId(entityId: string): Promise<ListingRow | undefined> };
  identity: Pick<IdentityService, 'getListingKeypair' | 'withDeveloperKeypair' | 'createDerivationProof'>;
  payments: Pick<PaymentProcessor, 'evmAddress'>;
  publicUrl: string;
  /** Registry the listing is registered with, advertised as `x-zynd.registry`. */
  registryUrl?: string;
  /** Gateway-wide default price, used by listings without their own. */
  defaultPriceUsd?: string;
}

export type AgentCard = Record<string, unknown> & { url: string; signatures: { protected: string; signature: string; header: { kid: string } }[] };

const b64url = (b64: string): string => b64.replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64urlJson = (v: unknown): string => b64url(Buffer.from(JSON.stringify(v), 'utf8').toString('base64'));

/** Detached JWS over the JCS body, exactly as the SDK's `signAgentCard`. */
export function signAgentCard(card: Record<string, unknown>, keypair: Ed25519Keypair): AgentCard {
  const { signatures: _s, signature: _g, ...body } = card;
  const protectedB64 = b64urlJson({ alg: 'EdDSA', typ: 'agent-card+jcs+jws' });
  const input = new TextEncoder().encode(`${protectedB64}.${canonicalJson(body)}`);
  const sig = Buffer.from(ed25519.sign(input, keypair.privateKey)).toString('base64');
  return { ...body, signatures: [{ protected: protectedB64, signature: b64url(sig), header: { kid: publicKeyString(keypair.publicKey) } }] } as AgentCard;
}

export class AgentCardService {
  /** The derivation proof is deterministic, so it is computed once per listing (it needs the developer key). */
  private readonly proofs = new Map<string, DerivationProof>();

  constructor(private readonly deps: AgentCardServiceDeps) {}

  async build(entityId: string): Promise<AgentCard> {
    const listing = await this.deps.listings.getByEntityId(entityId);
    if (!listing?.entityId) throw new ApiError('NOT_FOUND', 'Unknown agent');
    const { identity, payments } = this.deps;

    const agent = await identity.getListingKeypair({ listingId: listing.id, developerId: listing.developerId, derivedKeyIndex: listing.derivedKeyIndex });
    const proof = await this.proofFor(listing, agent);
    const price = effectivePriceUsd(listing.priceUsd, this.deps.defaultPriceUsd);
    const entityUrl = `${this.deps.publicUrl}/a/${listing.entityId}`;
    const modes = ['text/plain', 'application/json'];

    const xZynd: Record<string, unknown> = {
      version: 1,
      entityId: listing.entityId,
      publicKey: publicKeyString(agent.publicKey),
      ...(this.deps.registryUrl ? { registry: this.deps.registryUrl } : {}),
      ...(price ? { pricing: { model: 'per-request', currency: 'USD', rates: { default: Number(price) }, paymentMethods: ['x402'] } } : {}),
      status: listing.status === 'ACTIVE' ? 'online' : 'offline',
      developerProof: proof,
      category: listing.category,
      tags: listing.tags,
      summary: listing.summary,
      walletAddress: payments.evmAddress(agent.privateKey),
      lastUpdatedAt: listing.updatedAt.toISOString(),
    };

    return signAgentCard(
      {
        protocolVersion: CARD_PROTOCOL_VERSION,
        name: listing.name,
        description: listing.summary,
        version: CARD_VERSION,
        url: `${entityUrl}/a2a/v1`,
        preferredTransport: 'JSONRPC',
        // The Gateway answers message/send, tasks/get and tasks/cancel; no streaming or push.
        capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
        defaultInputModes: modes,
        defaultOutputModes: modes,
        skills: [{ id: 'default', name: listing.name, description: listing.summary, tags: listing.tags, inputModes: modes, outputModes: modes }],
        logos: null,
        securitySchemes: {
          zyndSig: { type: 'http', scheme: 'ed25519-envelope', description: "Per-message Ed25519 signature in Message.metadata['x-zynd-auth']." },
        },
        security: [{ zyndSig: [] }],
        'x-zynd': xZynd,
      },
      agent,
    );
  }

  private async proofFor(listing: ListingRow, agent: Ed25519Keypair): Promise<DerivationProof> {
    const hit = this.proofs.get(listing.id);
    if (hit) return hit;
    const proof = await this.deps.identity.withDeveloperKeypair(listing.developerId, (dev) => this.deps.identity.createDerivationProof(dev, agent, listing.derivedKeyIndex));
    this.proofs.set(listing.id, proof);
    return proof;
  }
}

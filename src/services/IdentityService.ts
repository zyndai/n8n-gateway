// LLD > IdentityService (M1.1-M1.5, M1.3). Byte-compatible with the TS SDK (zyndai-ts-sdk
// src/identity.ts, src/registry.ts) and AgentDNS (agent-dns internal/identity): the same
// derivation, derivation proof, registration signable and heartbeat signature.
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ApiError } from '../errors.js';
import { canonicalJson } from './canonical.js';
import { decryptSecret } from './keyVault.js';

export interface Ed25519Keypair {
  /** 32-byte Ed25519 seed. */
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface SignedPayload {
  canonicalJson: string;
  /** `ed25519:<base64>` */
  signature: string;
}

export interface DerivationProof {
  developer_public_key: string;
  entity_index: number;
  developer_signature: string;
}

/** The fields AgentDNS verifies on `POST /v1/entities` (public_key is added by the signer). */
export interface RegistrationEntity {
  name: string;
  entity_url: string;
  category: string;
  summary: string;
  tags: string[];
  entity_type?: string;
}

export interface DeveloperKeyRecord {
  /** Dashboard `private_key_enc`. */
  privateKeyEnc: string;
  /** Dashboard `public_key`; may be empty for old rows, in which case the cross-check is skipped. */
  publicKey: string;
}

/** Where encrypted developer keys come from. The Drizzle implementation lives in ListingStore. */
export interface DeveloperKeySource {
  getDeveloperKey(developerId: string): Promise<DeveloperKeyRecord | undefined>;
}

export interface ListingKeyRef {
  listingId: string;
  developerId: string;
  derivedKeyIndex: number;
}

const AGENT_DOMAIN = new TextEncoder().encode('zns:agent:');
const ED25519_PREFIX = 'ed25519:';

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const stripPrefix = (s: string): string => (s.startsWith(ED25519_PREFIX) ? s.slice(ED25519_PREFIX.length) : s);

function uint32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`index out of range: ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function keypairFromSeed(seed: Uint8Array): Ed25519Keypair {
  if (seed.length !== 32) throw new RangeError(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
  return { privateKey: Uint8Array.from(seed), publicKey: ed25519.getPublicKey(seed) };
}

export function publicKeyString(publicKey: Uint8Array): string {
  return `${ED25519_PREFIX}${b64(publicKey)}`;
}

/** `zns:` + first 16 bytes of SHA-256(public key), hex. Known before registration. */
export function entityIdFor(publicKey: Uint8Array): string {
  return `zns:${bytesToHex(sha256(publicKey).slice(0, 16))}`;
}

function signBytes(keypair: Ed25519Keypair, message: Uint8Array): string {
  return `${ED25519_PREFIX}${b64(ed25519.sign(message, keypair.privateKey))}`;
}

/** RFC 3339 at second precision, e.g. 2026-11-10T02:30:00Z (AgentDNS parses with time.RFC3339). */
function rfc3339(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class IdentityService {
  private readonly cache = new Map<string, { developerId: string; keypair: Promise<Ed25519Keypair> }>();

  constructor(
    private readonly deps: { masterKey?: Buffer; keySource?: DeveloperKeySource } = {},
  ) {}

  // --- Pure crypto -------------------------------------------------------------------------

  /** M1.1: agent_seed = SHA-512(devSeed || "zns:agent:" || uint32_be(index))[:32]. */
  deriveKeypair(devPrivateKey: Uint8Array, index: number): Ed25519Keypair {
    if (devPrivateKey.length !== 32) throw new RangeError('developer seed must be 32 bytes');
    const seed = sha512(concat(devPrivateKey, AGENT_DOMAIN, uint32be(index))).slice(0, 32);
    return keypairFromSeed(seed);
  }

  /** M1.4: canonical JSON of the registration fields (plus public_key) and its signature. */
  signRegistration(keypair: Ed25519Keypair, entity: RegistrationEntity): SignedPayload {
    const signable: Record<string, unknown> = {
      category: entity.category,
      entity_url: entity.entity_url,
      name: entity.name,
      public_key: publicKeyString(keypair.publicKey),
      summary: entity.summary,
      tags: entity.tags,
    };
    // Only included when set, matching AgentDNS's conditional include.
    if (entity.entity_type) signable.entity_type = entity.entity_type;
    const json = canonicalJson(signable);
    return { canonicalJson: json, signature: signBytes(keypair, new TextEncoder().encode(json)) };
  }

  /** M1.5: signature is over the timestamp's UTF-8 bytes. */
  signHeartbeat(keypair: Ed25519Keypair, now: Date = new Date()): { timestamp: string; signature: string } {
    const timestamp = rfc3339(now);
    return { timestamp, signature: signBytes(keypair, new TextEncoder().encode(timestamp)) };
  }

  /** M1.4: the developer signs (agent_public_key || uint32_be(index)). */
  createDerivationProof(dev: Ed25519Keypair, agent: Ed25519Keypair, index: number): DerivationProof {
    return {
      developer_public_key: publicKeyString(dev.publicKey),
      entity_index: index,
      developer_signature: signBytes(dev, concat(agent.publicKey, uint32be(index))),
    };
  }

  // --- Key loading + cache -----------------------------------------------------------------

  /**
   * Decrypt the developer master key (AES-256-GCM, same path as the dashboard's
   * `decryptPrivateKey`) and return it as a keypair. The caller owns the result and should
   * pass it to `zero()` when finished; prefer `withDeveloperKeypair`.
   */
  async loadDeveloperKeypair(developerId: string): Promise<Ed25519Keypair> {
    const { masterKey, keySource } = this.deps;
    if (!masterKey || !keySource) throw new ApiError('INTERNAL', 'IdentityService is not configured with a key source');
    const rec = await keySource.getDeveloperKey(developerId);
    if (!rec) throw new ApiError('NOT_FOUND', 'Developer key not found');

    let seed: Uint8Array;
    try {
      const plain = decryptSecret(rec.privateKeyEnc, masterKey);
      const raw = Buffer.from(stripPrefix(plain), 'base64');
      // Stored as the base64 of 32-byte seed, or 64-byte seed||public (Go ed25519.PrivateKey).
      if (raw.length !== 32 && raw.length !== 64) throw new Error(`unexpected key length ${raw.length}`);
      seed = Uint8Array.from(raw.subarray(0, 32));
      raw.fill(0);
    } catch (err) {
      // Never include key material or ciphertext in the message.
      throw new ApiError('INTERNAL', 'Could not decrypt developer key', { reason: (err as Error).message });
    }

    const kp = keypairFromSeed(seed);
    seed.fill(0);
    if (rec.publicKey && stripPrefix(rec.publicKey) !== b64(kp.publicKey)) {
      zero(kp);
      throw new ApiError('INTERNAL', 'Developer key does not match its stored public key');
    }
    return kp;
  }

  async withDeveloperKeypair<T>(developerId: string, fn: (dev: Ed25519Keypair) => Promise<T> | T): Promise<T> {
    const dev = await this.loadDeveloperKeypair(developerId);
    try {
      return await fn(dev);
    } finally {
      zero(dev);
    }
  }

  /**
   * M1.3: derive (and cache) the keypair for a listing. The first call decrypts the developer
   * key; later calls for the same listing do no decryption. Concurrent first calls share one
   * decryption. The developer master key itself is never cached.
   */
  getListingKeypair(ref: ListingKeyRef): Promise<Ed25519Keypair> {
    const hit = this.cache.get(ref.listingId);
    if (hit) return hit.keypair;
    const keypair = this.withDeveloperKeypair(ref.developerId, (dev) => this.deriveKeypair(dev.privateKey, ref.derivedKeyIndex));
    this.cache.set(ref.listingId, { developerId: ref.developerId, keypair });
    keypair.catch(() => {
      if (this.cache.get(ref.listingId)?.keypair === keypair) this.cache.delete(ref.listingId);
    });
    return keypair;
  }

  /** Drop a listing's cached keypair (deactivation, deletion). */
  invalidate(listingId: string): void {
    this.cache.delete(listingId);
  }

  /** Drop every cached keypair of a developer (key rotation, M6.4). */
  invalidateDeveloper(developerId: string): void {
    for (const [listingId, entry] of this.cache) if (entry.developerId === developerId) this.cache.delete(listingId);
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}

function zero(kp: Ed25519Keypair): void {
  kp.privateKey.fill(0);
}

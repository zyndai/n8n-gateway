// Silent developer setup for Zynd Studio (POST /internal/v1/provision). A person who signs in with Google
// gets a Zynd developer identity and a handle without ever seeing a setup page. It repeats what the
// dashboard's register route does (`src/app/api/developer/register/route.ts`): registry approve,
// re-encrypt the returned key under PKI_ENCRYPTION_KEY, insert a `developer_keys` row, claim the handle
// and verify it. Idempotent: a user who already has a developer, from here or from the dashboard, gets
// that developer back, and one without a handle gets one.
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import { ApiError } from '../errors.js';
import { AgentDnsError, toGatewayError, type AgentDnsClient } from './AgentDnsClient.js';
import { DuplicateDeveloperError, type DeveloperDirectory, type DeveloperRecord } from './DeveloperStore.js';
import { canonicalJson } from './canonical.js';
import { decryptSecret, encryptSecret } from './keyVault.js';
import { publicKeyString } from './IdentityService.js';

export interface ProvisionedDeveloper {
  developerId: string;
  handle: string;
  name: string;
  /** True only when this call created the developer. */
  created: boolean;
}

export interface ProvisionDeps {
  directory: DeveloperDirectory;
  registry: Pick<AgentDnsClient, 'approveDeveloper' | 'handleAvailable' | 'claimHandle' | 'verifyHandle'>;
  /** The registry's admin (webhook) secret: `AGENTDNS_WEBHOOK_SECRET`, the same one the dashboard uses. */
  adminSecret: string;
  masterKey: Buffer;
  /** Random integer in [0, n). Tests pass a fixed sequence. */
  random?: (n: number) => number;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/** Handle rules of the registry (`zns.ValidateHandle`). */
const HANDLE_RE = /^[a-z][a-z0-9-]{2,39}$/;
const SLUG_MAX = 30;
const SUFFIX = 'abcdefghijklmnopqrstuvwxyz0123456789';
const HANDLE_ATTEMPTS = 6;
const NAME_MAX = 100;

export const isValidHandle = (h: string): boolean => HANDLE_RE.test(h) && !h.endsWith('-') && !h.includes('--');

/**
 * A handle from a person's name: its lowercase slug plus 4 random characters, e.g. "Ada Lovelace" ->
 * `ada-lovelace-x7k2`. The suffix keeps clashes rare and means a reserved word can never come out.
 */
export function makeHandle(name: string, random: (n: number) => number = randomInt): string {
  let slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(slug)) slug = slug ? `user-${slug}` : 'user';
  slug = slug.slice(0, SLUG_MAX).replace(/-+$/g, '');
  const suffix = Array.from({ length: 4 }, () => SUFFIX[random(SUFFIX.length)]).join('');
  return `${slug}-${suffix}`;
}

/** Undo the registry's `models.EncryptPrivateKey`: AES-256-GCM under SHA-256(state), base64(nonce || ciphertext || tag). */
function decryptRegistryKey(ciphertextB64: string, state: string): string {
  const buf = Buffer.from(ciphertextB64, 'base64');
  if (buf.length < 12 + 16) throw new Error('registry key ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(state).digest(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]).toString('utf8');
}

export class ProvisionService {
  /** One provision at a time per user, so two quick sign-ins cannot create two registry developers. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;

  constructor(private readonly deps: ProvisionDeps) {
    this.log = deps.log ?? console;
  }

  async provision(userId: string, name: string): Promise<ProvisionedDeveloper> {
    const previous = this.inFlight.get(userId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.provisionNow(userId, name));
    this.inFlight.set(userId, run);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(userId) === run) this.inFlight.delete(userId);
    }
  }

  private async provisionNow(userId: string, rawName: string): Promise<ProvisionedDeveloper> {
    const name = rawName.trim().slice(0, NAME_MAX) || 'Zynd Studio user';
    try {
      let dev = await this.deps.directory.findByUserId(userId);
      let created = false;
      if (!dev) ({ dev, created } = await this.createDeveloper(userId, name));
      const handle = dev.username ?? (await this.giveHandle(dev, name)).username;
      if (!handle) throw new ApiError('INTERNAL', 'Developer has no handle');
      return { developerId: dev.developerId, handle, name: dev.name, created };
    } catch (err) {
      // Registry trouble becomes a 502 the caller can retry; the steps already done are kept and resumed.
      if (err instanceof AgentDnsError) throw toGatewayError(err);
      throw err;
    }
  }

  private async createDeveloper(userId: string, name: string): Promise<{ dev: DeveloperRecord; created: boolean }> {
    const { registry, adminSecret, masterKey, directory } = this.deps;
    const state = randomBytes(16).toString('hex');
    const approved = await registry.approveDeveloper(adminSecret, { name, state, metadata: { username: '', role: '' } });
    let rawKey: string;
    try {
      rawKey = decryptRegistryKey(approved.private_key_enc, state);
    } catch (err) {
      // Never include key material in the message.
      this.log.error(`provision: could not decrypt the key the registry returned for ${approved.developer_id}: ${(err as Error).message}`);
      throw new ApiError('GATEWAY_UNAVAILABLE', 'AgentDNS returned a key that could not be read');
    }
    try {
      const dev = await directory.insert({
        userId,
        developerId: approved.developer_id,
        publicKey: approved.public_key,
        privateKeyEnc: encryptSecret(rawKey, masterKey),
        name,
      });
      this.log.info(`provision: created developer ${dev.developerId}`);
      return { dev, created: true };
    } catch (err) {
      if (!(err instanceof DuplicateDeveloperError)) throw err;
      // Another process (a second Gateway, the dashboard) created this user's developer first. Use theirs;
      // the one just approved is left unused on the registry.
      this.log.warn(`provision: ${approved.developer_id} approved but the user already has a developer; left unused`);
      const existing = await directory.findByUserId(userId);
      if (!existing) throw new ApiError('INTERNAL', 'Developer vanished during provisioning');
      return { dev: existing, created: false };
    }
  }

  /** Claim, verify and save a handle for a developer that has none. */
  private async giveHandle(dev: DeveloperRecord, name: string): Promise<DeveloperRecord> {
    const seed = this.seedOf(dev, this.deps.masterKey);
    try {
      const publicKey = dev.publicKey || publicKeyString(ed25519.getPublicKey(seed));
      for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt++) {
        const handle = makeHandle(dev.name || name, this.deps.random);
        if (!(await this.claimHandle(dev, publicKey, seed, handle))) continue;
        const saved = await this.deps.directory.setUsername(dev.userId, handle);
        if (saved === 'taken') continue;
        if (saved === 'already_set') {
          // Someone gave this developer a handle while we were claiming ours; theirs wins.
          const current = await this.deps.directory.findByUserId(dev.userId);
          if (current?.username) return current;
          continue;
        }
        this.log.info(`provision: ${dev.developerId} claimed handle ${handle}`);
        return { ...dev, username: handle };
      }
      throw new ApiError('CONFLICT', 'Could not find a free handle, try again');
    } finally {
      seed.fill(0);
    }
  }

  /** Check, claim (signed by the developer) and verify one handle. False when it is taken locally or on the registry. */
  private async claimHandle(dev: DeveloperRecord, publicKey: string, seed: Uint8Array, handle: string): Promise<boolean> {
    const { directory, registry } = this.deps;
    if (await directory.usernameTaken(handle)) return false;
    // A failed availability check is not fatal: the claim itself answers 409 when the handle is taken.
    if (!(await registry.handleAvailable(handle).catch(() => true))) return false;

    const signed = canonicalJson({ developer_id: dev.developerId, handle, public_key: publicKey });
    const signature = `ed25519:${Buffer.from(ed25519.sign(new TextEncoder().encode(signed), seed)).toString('base64')}`;
    try {
      await registry.claimHandle({ handle, developer_id: dev.developerId, public_key: publicKey, signature });
    } catch (err) {
      if (err instanceof AgentDnsError && err.status === 409) return false;
      throw err;
    }
    // Like the dashboard: a verification that fails does not undo the claim.
    await registry.verifyHandle(handle).catch((err: unknown) => this.log.warn(`provision: verifying ${handle} failed: ${(err as Error).message}`));
    return true;
  }

  private seedOf(dev: DeveloperRecord, masterKey: Buffer): Uint8Array {
    try {
      const raw = Buffer.from(decryptSecret(dev.privateKeyEnc, masterKey).replace(/^ed25519:/, ''), 'base64');
      if (raw.length !== 32 && raw.length !== 64) throw new Error(`unexpected key length ${raw.length}`);
      const seed = Uint8Array.from(raw.subarray(0, 32));
      raw.fill(0);
      return seed;
    } catch (err) {
      throw new ApiError('INTERNAL', 'Could not decrypt developer key', { reason: (err as Error).message });
    }
  }
}

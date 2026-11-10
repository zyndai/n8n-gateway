// `x-zynd-auth`: per-message Ed25519 authorisation for A2A traffic (M2.6, HLD > Security Model).
// Wire format is that of the TS SDK (zyndai-ts-sdk src/a2a/auth.ts): the block lives in
// `message.metadata["x-zynd-auth"]` and the signature covers
//   "ZYND-A2A-MSG-v1\n" ‖ JCS(message with auth.signature = "")
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from 'node:crypto';
import { ApiError } from '../errors.js';
import { canonicalJson } from './canonical.js';
import { entityIdFor, publicKeyString, type Ed25519Keypair } from './IdentityService.js';
import type { NonceStoreLike } from './NonceStore.js';

export const ZYND_AUTH_KEY = 'x-zynd-auth';
export const ZYND_AUTH_VERSION = 1;
const DOMAIN_TAG = 'ZYND-A2A-MSG-v1\n';
const ED25519_PREFIX = 'ed25519:';
/** Allowed clock skew for `issued_at`, and the longest lifetime we accept (bounds the nonce table). */
const SKEW_MS = 60_000;
const MAX_LIFETIME_MS = 10 * 60_000;

/** SDK-compatible JSON-RPC codes for auth failures. */
export const RPC_AUTH_FAILED = -32100;
export const RPC_REPLAY_DETECTED = -32101;
export const RPC_AUTH_EXPIRED = -32102;

export interface A2AMessage {
  messageId?: string;
  role?: string;
  parts?: unknown[];
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ZyndAuthBlock {
  v: number;
  entity_id: string;
  fqan?: string;
  public_key: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
  signature: string;
  developer_proof?: unknown;
}

export interface VerifiedCaller {
  entityId: string;
  publicKey: string;
  fqan: string | null;
}

/** An auth failure that also knows which JSON-RPC code the A2A route should report. */
export class ZyndAuthError extends ApiError {
  constructor(
    code: 'AUTH_INVALID' | 'AUTH_EXPIRED',
    message: string,
    readonly rpcCode: number,
  ) {
    super(code, message);
    this.name = 'ZyndAuthError';
  }
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

function sigInput(message: A2AMessage): Uint8Array {
  return new TextEncoder().encode(DOMAIN_TAG + canonicalJson(message));
}

/** Deep copy through JSON so verification never mutates the request body. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function extractAuth(message: A2AMessage): ZyndAuthBlock | undefined {
  const raw = message.metadata?.[ZYND_AUTH_KEY];
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ZyndAuthBlock) : undefined;
}

/**
 * Verify the auth block on an inbound message and claim its nonce. Order matters: the nonce is
 * claimed only after the signature checks out, so a forged message cannot burn a real caller's nonce.
 */
export async function verifyZyndAuth(
  message: A2AMessage,
  nonces: NonceStoreLike,
  now: Date = new Date(),
): Promise<VerifiedCaller> {
  const auth = extractAuth(message);
  if (!auth) throw new ZyndAuthError('AUTH_INVALID', 'x-zynd-auth is required', RPC_AUTH_FAILED);
  if (auth.v !== ZYND_AUTH_VERSION) throw new ZyndAuthError('AUTH_INVALID', `Unsupported x-zynd-auth version: ${String(auth.v)}`, RPC_AUTH_FAILED);
  for (const f of ['entity_id', 'public_key', 'nonce', 'issued_at', 'expires_at', 'signature'] as const) {
    if (typeof auth[f] !== 'string' || !auth[f]) throw new ZyndAuthError('AUTH_INVALID', `x-zynd-auth.${f} is missing`, RPC_AUTH_FAILED);
  }

  const issuedAt = Date.parse(auth.issued_at);
  const expiresAt = Date.parse(auth.expires_at);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) throw new ZyndAuthError('AUTH_EXPIRED', 'x-zynd-auth timestamps are not RFC 3339', RPC_AUTH_EXPIRED);
  const t = now.getTime();
  if (t > expiresAt) throw new ZyndAuthError('AUTH_EXPIRED', 'x-zynd-auth has expired', RPC_AUTH_EXPIRED);
  if (t < issuedAt - SKEW_MS) throw new ZyndAuthError('AUTH_EXPIRED', 'x-zynd-auth was issued in the future', RPC_AUTH_EXPIRED);
  if (expiresAt - issuedAt > MAX_LIFETIME_MS) throw new ZyndAuthError('AUTH_INVALID', 'x-zynd-auth lifetime is too long', RPC_AUTH_FAILED);

  let pub: Uint8Array;
  try {
    pub = Uint8Array.from(Buffer.from(auth.public_key.replace(/^ed25519:/, ''), 'base64'));
    if (pub.length !== 32) throw new Error('bad length');
  } catch {
    throw new ZyndAuthError('AUTH_INVALID', 'x-zynd-auth.public_key is not an Ed25519 key', RPC_AUTH_FAILED);
  }
  // entity ids are zns:<32 hex> (agent) or zns:svc:<32 hex>; either way the hash prefix must match the key.
  if (entityIdFor(pub).replace(/^zns:/, '') !== auth.entity_id.replace(/^zns:(svc:)?/, '')) {
    throw new ZyndAuthError('AUTH_INVALID', 'x-zynd-auth.entity_id does not match its public key', RPC_AUTH_FAILED);
  }

  const copy = clone(message);
  (copy.metadata?.[ZYND_AUTH_KEY] as ZyndAuthBlock).signature = '';
  let ok = false;
  try {
    const sig = Buffer.from(auth.signature.replace(/^ed25519:/, ''), 'base64');
    ok = sig.length === 64 && ed25519.verify(sig, sigInput(copy), pub);
  } catch {
    ok = false;
  }
  if (!ok) throw new ZyndAuthError('AUTH_INVALID', 'x-zynd-auth signature did not verify', RPC_AUTH_FAILED);

  const fresh = await nonces.claim(`${auth.entity_id}:${auth.nonce}`, new Date(expiresAt + SKEW_MS));
  if (!fresh) throw new ZyndAuthError('AUTH_INVALID', 'x-zynd-auth nonce was already used', RPC_REPLAY_DETECTED);

  return { entityId: auth.entity_id, publicKey: auth.public_key, fqan: typeof auth.fqan === 'string' ? auth.fqan : null };
}

/** Sign `message` in place as `keypair` (outbound calls). Same rules the SDK's `signMessage` follows. */
export function signZyndAuth(message: A2AMessage, keypair: Ed25519Keypair, ttlMs = SKEW_MS, now: Date = new Date()): A2AMessage {
  const auth: ZyndAuthBlock = {
    v: ZYND_AUTH_VERSION,
    entity_id: entityIdFor(keypair.publicKey),
    public_key: publicKeyString(keypair.publicKey),
    nonce: b64(randomBytes(16)),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    signature: '',
  };
  message.metadata = { ...message.metadata, [ZYND_AUTH_KEY]: auth };
  auth.signature = `${ED25519_PREFIX}${b64(ed25519.sign(sigInput(message), keypair.privateKey))}`;
  return message;
}

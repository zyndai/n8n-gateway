// LLD > PaymentProcessor (M2.7, M2.13). x402 v2, "exact" scheme on an EVM network: the payer signs
// an EIP-3009 `TransferWithAuthorization` and the facilitator submits it on chain.
//
//   inbound   verifyX402 (before the job runs)  ->  settle (after it completes, so failed jobs are not charged)
//   outbound  parsePaymentRequired (from the target's 402)  ->  signX402 (developer key)
//
// The EVM key is SHA-256(Ed25519 seed), the same derivation as both Zynd SDKs, so an address
// matches what the SDK shows for the same identity. Header names follow @x402/core v2:
// PAYMENT-REQUIRED (402 response), PAYMENT-SIGNATURE (request), PAYMENT-RESPONSE (settlement).
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';
import type { X402Config } from '../config.js';
import { ApiError } from '../errors.js';
import { fromHex, hex, isAddress, privateKeyToAddress, recoverSigner, signDigest, transferAuthorizationDigest } from './evm.js';
import { atomicToMicroUsd, microUsdToAtomic, parseUsd } from './money.js';

export type HeaderBag = Record<string, string | string[] | undefined>;

export interface PaymentRequirements {
  scheme: 'exact';
  /** CAIP-2, e.g. `eip155:84532`. */
  network: string;
  /** Token atomic units, as a decimal string. */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** EIP-712 domain of the token: `{ name, version }`. */
  extra: { name: string; version: string; [k: string]: unknown };
}

export interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface PaymentPayload {
  x402Version: 2;
  resource?: { url: string; description?: string };
  accepted: PaymentRequirements;
  payload: { authorization: Authorization; signature: string };
}

export interface VerifiedPayment {
  payer: string;
  /** Amount in micro-USD (6 decimals), rounded up. */
  amountMicroUsd: bigint;
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
}

export interface SettledPayment {
  transaction: string;
  payer: string;
}

export interface SignedPayment {
  /** `{ 'PAYMENT-SIGNATURE': base64(JSON) }`, ready to attach to the retried request. */
  headers: Record<string, string>;
  payer: string;
  amountMicroUsd: bigint;
}

const SIGNATURE_HEADERS = ['payment-signature', 'x-payment'];
/** Clock slack when checking validAfter / validBefore. */
const SKEW_S = 6;
const FACILITATOR_TIMEOUT_MS = 15_000;

const b64encode = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
function b64decode(s: string): unknown {
  return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
}

function first(h: HeaderBag, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = h[n] ?? h[n.toLowerCase()];
    if (Array.isArray(v)) return v[0];
    if (v) return v;
  }
  return undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const sameAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function bigint(v: string, what: string): bigint {
  if (!/^\d{1,78}$/.test(v)) throw new ApiError('PAYMENT_FAILED', `Invalid payment: ${what}`);
  return BigInt(v);
}

export interface PaymentProcessorDeps {
  config: X402Config;
  fetch?: typeof fetch;
  now?: () => number;
}

export class PaymentProcessor {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** EIP-3009 nonces already accepted by this process -> expiry (ms). Stops a proof being reused while a job runs. */
  private readonly usedNonces = new Map<string, number>();

  constructor(private readonly deps: PaymentProcessorDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  // --- keys ----------------------------------------------------------------------------------

  /** M2.13: secp256k1 private key = SHA-256 of the 32-byte Ed25519 seed. */
  deriveEvmKey(ed25519PrivateKey: Uint8Array): Uint8Array {
    if (ed25519PrivateKey.length !== 32) throw new RangeError('Ed25519 seed must be 32 bytes');
    return sha256(ed25519PrivateKey);
  }

  /** EIP-55 address that receives (or pays) for an identity. */
  evmAddress(ed25519PrivateKey: Uint8Array): string {
    const key = this.deriveEvmKey(ed25519PrivateKey);
    try {
      return privateKeyToAddress(key);
    } finally {
      key.fill(0);
    }
  }

  // --- requirements (inbound) ----------------------------------------------------------------

  /** What an inbound caller must pay to use a listing. `payTo` is the listing's own EVM address. */
  requirementsFor(payTo: string, amountUsd: string): PaymentRequirements {
    const c = this.deps.config;
    return {
      scheme: 'exact',
      network: c.network,
      amount: microUsdToAtomic(parseUsd(amountUsd, 'price'), c.assetDecimals).toString(),
      asset: c.asset,
      payTo,
      // The authorization must outlive the job (300 s cap) because settlement happens after it.
      maxTimeoutSeconds: 600,
      extra: { name: c.assetName, version: c.assetVersion },
    };
  }

  /** Base64 body of the `PAYMENT-REQUIRED` response header. */
  paymentRequiredHeader(requirements: PaymentRequirements, resourceUrl: string, error?: string): string {
    return b64encode({ x402Version: 2, ...(error ? { error } : {}), resource: { url: resourceUrl }, accepts: [requirements] });
  }

  // --- verify / settle (inbound, M2.7) -------------------------------------------------------

  /**
   * Check a payment proof against `requirements`: structure, amount, recipient, validity window,
   * EIP-712 signature, in-process replay, then the facilitator's `/verify`. Throws
   * `PAYMENT_FAILED` (402) for an invalid proof and `GATEWAY_UNAVAILABLE` when the facilitator
   * cannot be reached.
   */
  async verifyX402(headers: HeaderBag, requirements: PaymentRequirements): Promise<VerifiedPayment> {
    const raw = first(headers, ...SIGNATURE_HEADERS);
    if (!raw) throw new ApiError('PAYMENT_FAILED', 'Payment required', { reason: 'missing_payment' });
    const payload = this.decodePayload(raw);
    const { authorization: a, signature } = payload.payload;

    const acc = payload.accepted;
    if (acc.scheme !== requirements.scheme || acc.network !== requirements.network || !sameAddr(acc.asset, requirements.asset) || !sameAddr(acc.payTo, requirements.payTo) || acc.amount !== requirements.amount) {
      throw new ApiError('PAYMENT_FAILED', 'Payment does not match the requirements', { reason: 'requirements_mismatch' });
    }
    if (!sameAddr(a.to, requirements.payTo) || a.value !== requirements.amount) {
      throw new ApiError('PAYMENT_FAILED', 'Payment authorization does not match the requirements', { reason: 'authorization_mismatch' });
    }
    const nowS = Math.floor(this.now() / 1000);
    const validAfter = bigint(a.validAfter, 'validAfter');
    const validBefore = bigint(a.validBefore, 'validBefore');
    if (validAfter > BigInt(nowS + SKEW_S)) throw new ApiError('PAYMENT_FAILED', 'Payment is not valid yet', { reason: 'not_yet_valid' });
    if (validBefore <= BigInt(nowS - SKEW_S)) throw new ApiError('PAYMENT_FAILED', 'Payment authorization expired', { reason: 'expired' });

    const chainId = this.chainId(requirements.network);
    const digest = transferAuthorizationDigest(
      { name: requirements.extra.name, version: requirements.extra.version, chainId, verifyingContract: requirements.asset },
      { from: a.from, to: a.to, value: bigint(a.value, 'value'), validAfter, validBefore, nonce: a.nonce },
    );
    const signer = recoverSigner(digest, signature);
    if (!signer || !sameAddr(signer, a.from)) throw new ApiError('PAYMENT_FAILED', 'Invalid payment signature', { reason: 'bad_signature' });

    this.claimNonce(a.nonce, Number(validBefore) * 1000);
    try {
      const res = await this.facilitator<{ isValid?: boolean; invalidReason?: string }>('verify', payload, requirements);
      if (!res.isValid) throw new ApiError('PAYMENT_FAILED', 'Payment rejected by the facilitator', { reason: res.invalidReason ?? 'invalid' });
    } catch (err) {
      this.usedNonces.delete(a.nonce.toLowerCase());
      throw err;
    }

    return { payer: a.from, amountMicroUsd: atomicToMicroUsd(BigInt(a.value), this.deps.config.assetDecimals), paymentPayload: payload, requirements };
  }

  /** Submit a verified payment on chain via the facilitator. Call once the job has succeeded. */
  async settle(verified: VerifiedPayment): Promise<SettledPayment> {
    const res = await this.facilitator<{ success?: boolean; transaction?: string; payer?: string; errorReason?: string }>('settle', verified.paymentPayload, verified.requirements);
    if (!res.success || !res.transaction) throw new ApiError('PAYMENT_FAILED', 'Payment settlement failed', { reason: res.errorReason ?? 'settle_failed' });
    return { transaction: res.transaction, payer: res.payer ?? verified.payer };
  }

  /** Release a verified-but-unsettled proof (job failed), so the caller may reuse the authorization. */
  release(verified: VerifiedPayment): void {
    this.usedNonces.delete(verified.paymentPayload.payload.authorization.nonce.toLowerCase());
  }

  // --- sign (outbound, M2.13) ----------------------------------------------------------------

  /**
   * Sign a payment for `requirements` with the EVM key derived from the developer's Ed25519 seed.
   * The caller (AgentCaller) has already checked the amount against `maxPaymentUsd` and the spend cap.
   */
  signX402(devPrivateKey: Uint8Array, requirements: PaymentRequirements): SignedPayment {
    if (requirements.scheme !== 'exact') throw new ApiError('PAYMENT_FAILED', `Unsupported payment scheme: ${requirements.scheme}`);
    if (!isAddress(requirements.payTo) || !isAddress(requirements.asset)) throw new ApiError('PAYMENT_FAILED', 'Payment requirements carry an invalid address');
    const key = this.deriveEvmKey(devPrivateKey);
    try {
      const from = privateKeyToAddress(key);
      const nowS = Math.floor(this.now() / 1000);
      const authorization: Authorization = {
        from,
        to: requirements.payTo,
        value: requirements.amount,
        validAfter: String(nowS - 600),
        validBefore: String(nowS + requirements.maxTimeoutSeconds),
        nonce: hex(randomBytes(32)),
      };
      const digest = transferAuthorizationDigest(
        { name: requirements.extra.name, version: requirements.extra.version, chainId: this.chainId(requirements.network), verifyingContract: requirements.asset },
        { from, to: authorization.to, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce },
      );
      const payload: PaymentPayload = { x402Version: 2, accepted: requirements, payload: { authorization, signature: signDigest(key, digest) } };
      return {
        headers: { 'PAYMENT-SIGNATURE': b64encode(payload) },
        payer: from,
        amountMicroUsd: atomicToMicroUsd(BigInt(requirements.amount), this.deps.config.assetDecimals),
      };
    } finally {
      key.fill(0);
    }
  }

  /** Read the requirements out of a target's 402 response (header first, JSON body as fallback). */
  parsePaymentRequired(headers: HeaderBag, body: unknown): PaymentRequirements {
    let doc: unknown = body;
    const header = first(headers, 'payment-required');
    if (header) {
      try {
        doc = b64decode(header);
      } catch {
        throw new ApiError('PAYMENT_FAILED', 'Target sent an unreadable PAYMENT-REQUIRED header');
      }
    }
    if (!isObj(doc) || doc.x402Version !== 2 || !Array.isArray(doc.accepts)) {
      throw new ApiError('PAYMENT_FAILED', 'Target asked for a payment this Gateway cannot make (x402 v2 required)');
    }
    const options = doc.accepts.map((a) => this.toRequirements(a)).filter((r): r is PaymentRequirements => r !== undefined);
    const pick = options.find((r) => r.network === this.deps.config.network) ?? options[0];
    if (!pick) throw new ApiError('PAYMENT_FAILED', 'Target accepts no payment scheme this Gateway supports (exact on an EVM network)');
    return pick;
  }

  /** `{ success, transaction }` from a `PAYMENT-RESPONSE` header, if present and readable. */
  parsePaymentResponse(headers: HeaderBag): { success: boolean; transaction?: string } | undefined {
    const header = first(headers, 'payment-response', 'x-payment-response');
    if (!header) return undefined;
    try {
      const d = b64decode(header);
      if (!isObj(d)) return undefined;
      return { success: d.success === true, ...(str(d.transaction) ? { transaction: str(d.transaction) as string } : {}) };
    } catch {
      return undefined;
    }
  }

  // --- internals -----------------------------------------------------------------------------

  private toRequirements(v: unknown): PaymentRequirements | undefined {
    if (!isObj(v) || v.scheme !== 'exact') return undefined;
    const network = str(v.network);
    const amount = str(v.amount);
    const asset = str(v.asset);
    const payTo = str(v.payTo);
    const extra = isObj(v.extra) ? v.extra : undefined;
    const name = str(extra?.name);
    const version = str(extra?.version);
    if (!network?.startsWith('eip155:') || !amount || !/^\d{1,78}$/.test(amount) || !asset || !payTo || !name || !version) return undefined;
    const timeout = typeof v.maxTimeoutSeconds === 'number' && v.maxTimeoutSeconds > 0 ? v.maxTimeoutSeconds : 60;
    return { scheme: 'exact', network, amount, asset, payTo, maxTimeoutSeconds: timeout, extra: { ...extra, name, version } };
  }

  private decodePayload(raw: string): PaymentPayload {
    let doc: unknown;
    try {
      doc = b64decode(raw);
    } catch {
      throw new ApiError('PAYMENT_FAILED', 'Unreadable payment header', { reason: 'malformed' });
    }
    const bad = (): never => {
      throw new ApiError('PAYMENT_FAILED', 'Malformed payment payload', { reason: 'malformed' });
    };
    if (!isObj(doc) || doc.x402Version !== 2) return bad();
    const accepted = this.toRequirements(doc.accepted);
    const inner = isObj(doc.payload) ? doc.payload : undefined;
    const auth = isObj(inner?.authorization) ? inner.authorization : undefined;
    const signature = str(inner?.signature);
    if (!accepted || !auth || !signature) return bad();
    const a = {
      from: str(auth.from),
      to: str(auth.to),
      value: str(auth.value),
      validAfter: str(auth.validAfter),
      validBefore: str(auth.validBefore),
      nonce: str(auth.nonce),
    };
    if (!a.from || !a.to || !a.value || !a.validAfter || !a.validBefore || !a.nonce) return bad();
    if (!isAddress(a.from) || !isAddress(a.to) || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return bad();
    try {
      fromHex(signature);
    } catch {
      return bad();
    }
    return { x402Version: 2, accepted, payload: { authorization: a as Authorization, signature } };
  }

  private chainId(network: string): bigint {
    const m = /^eip155:(\d{1,18})$/.exec(network);
    if (!m) throw new ApiError('PAYMENT_FAILED', `Unsupported network: ${network}`);
    return BigInt(m[1] as string);
  }

  private claimNonce(nonce: string, expiresAtMs: number): void {
    const now = this.now();
    for (const [n, exp] of this.usedNonces) if (exp < now) this.usedNonces.delete(n);
    const key = nonce.toLowerCase();
    if (this.usedNonces.has(key)) throw new ApiError('PAYMENT_FAILED', 'Payment authorization was already used', { reason: 'replayed' });
    this.usedNonces.set(key, expiresAtMs);
  }

  private async facilitator<T>(op: 'verify' | 'settle', paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.deps.config.facilitatorUrl}/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
        signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ApiError('GATEWAY_UNAVAILABLE', 'Payment facilitator unreachable', { reason: (err as Error).message });
    }
    const data = (await res.json().catch(() => undefined)) as T | undefined;
    // The facilitator answers 4xx with a structured body for an invalid payment; surface it as a payment failure.
    if (!res.ok) {
      if (res.status >= 500) throw new ApiError('GATEWAY_UNAVAILABLE', 'Payment facilitator error', { status: res.status });
      if (isObj(data)) return data as T;
      throw new ApiError('PAYMENT_FAILED', 'Payment rejected by the facilitator', { status: res.status });
    }
    if (!isObj(data)) throw new ApiError('GATEWAY_UNAVAILABLE', 'Payment facilitator returned an unreadable response');
    return data as T;
  }
}

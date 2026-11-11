// AirnodeHub calls for n8n workflows (Zynd x AirnodeHub showcase). n8n cannot sign x402, so the
// Gateway calls the Airnode, pays its 402 from a wallet it already holds, and checks the signature
// on the answer before handing it back. No key material reaches n8n.
//
//   POST {listingUrl}  { operation, parameters }
//     -> 402 + PAYMENT-REQUIRED       only aUSD on the configured network; amount <= maxPaymentUsd;
//                                     reserve it on the API key (spend cap), sign EIP-3009, retry
//     -> 200 { airnode, requestHash, timestamp, data, signature }
//        verify: requestHash is ours, and the EIP-191 signer of
//        keccak256(requestHash ‖ uint256 timestamp ‖ utf8(data)) is the address the listing
//        publishes under `x-airnode.address` (never the envelope's own `airnode` field).
//
// The payer is the developer wallet by default, or the wallet of one of the developer's listings
// (`payFromListingId`), so an agent can spend what it earns.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import type { AuthedApiKey } from '../middleware/apiKeyAuth.js';
import type { ApiKeyStoreLike } from './ApiKeyStore.js';
import { fromHex, isAddress, recoverSigner } from './evm.js';
import type { IdentityService } from './IdentityService.js';
import type { ListingStoreLike } from './ListingStore.js';
import { atomicToMicroUsd, formatUsd, parseUsd } from './money.js';
import type { PaymentProcessor, PaymentRequirements } from './PaymentProcessor.js';
import { logPayment, usd, type PaymentLogger } from './paymentLog.js';

export interface AirnodeConfig {
  /** Hostnames a listing URL may use. Default: AirnodeHub's `airnode-<name>.fly.dev`. */
  hostPattern: RegExp;
  /** The only token the Gateway will pay an Airnode in (aUSD on Base Sepolia by default). */
  asset: string;
  network: string;
  assetDecimals: number;
  /** Ceiling for one call when the workflow passes no `maxPaymentUsd`. */
  defaultMaxPaymentUsd: string;
  /** How long a listing's published signer address is cached. */
  docTtlMs: number;
  timeoutMs: number;
  /** Largest response body accepted, in bytes. */
  maxResponseBytes: number;
}

export const DEFAULT_AIRNODE_CONFIG: AirnodeConfig = {
  hostPattern: /^airnode-[a-z0-9-]+\.fly\.dev$/,
  asset: '0xbeA34973e5f67F18F656A2C6070C64326C791808',
  network: 'eip155:84532',
  assetDecimals: 6,
  defaultMaxPaymentUsd: '0.05',
  docTtlMs: 10 * 60_000,
  timeoutMs: 60_000,
  maxResponseBytes: 4 * 1024 * 1024,
};

export interface AirnodeClientDeps {
  config: AirnodeConfig;
  identity: Pick<IdentityService, 'withDeveloperKeypair' | 'getListingKeypair'>;
  store: Pick<ListingStoreLike, 'getOwned'>;
  payments: Pick<PaymentProcessor, 'signX402' | 'parsePaymentRequired' | 'parsePaymentResponse'>;
  apiKeys: Pick<ApiKeyStoreLike, 'reserveSpend' | 'refundSpend'>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Payment log lines (one per event). Defaults to `console`. */
  log?: PaymentLogger;
}

/** Who pays whom, repeated on every payment line of one call. */
type Who = Record<string, string | undefined>;

export interface Attestation {
  airnode: string;
  requestHash: string;
  timestamp: string;
  /** The upstream body exactly as signed. Keep it: re-verification needs these bytes. */
  data: string;
  signature: string;
}

export interface Verification {
  verified: boolean;
  /** Address recovered from the signature. */
  signer: string | null;
  /** Address the listing publishes under `x-airnode.address`. */
  expectedSigner: string;
  requestHashMatches: boolean;
  reason?: string;
}

export interface AirnodeCallRequest {
  listingUrl: unknown;
  operation: unknown;
  parameters?: unknown;
  maxPaymentUsd?: unknown;
  payFromListingId?: unknown;
}

export interface AirnodeCallResult {
  listingUrl: string;
  operation: string;
  parameters: Record<string, unknown>;
  /** `attestation.data` parsed as JSON when it is JSON, else the string. */
  data: unknown;
  attestation: Attestation;
  verification: Verification;
  payment: { amountUsd: string; transaction: string | null; payer: string } | null;
  /** ISO time of the signature. */
  signedAt: string;
}

export interface AirnodeVerifyRequest {
  listingUrl: unknown;
  operation: unknown;
  parameters?: unknown;
  attestation: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const OPERATION = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const EIP191_PREFIX = new TextEncoder().encode('\x19Ethereum Signed Message:\n32');

// --- request hash and digest (x-airnode.attestation, version 0.2.0) ---------------------------

/** Unicode code point order, as the spec requires (plain `sort()` compares UTF-16 units). */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] as string).codePointAt(0)! - (y[i] as string).codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** An object becomes `[name, value]` entries sorted by name, at any depth; arrays keep their order. */
function canonicalEntries(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalEntries);
  if (isObj(v)) {
    return Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort(byCodePoint)
      .map((k) => [k, canonicalEntries(v[k])]);
  }
  return v;
}

export function airnodeRequestHash(operation: string, parameters: Record<string, unknown>): string {
  const json = JSON.stringify([operation, canonicalEntries(parameters)]);
  return `0x${Buffer.from(keccak_256(new TextEncoder().encode(json))).toString('hex')}`;
}

/** EIP-191 hash of keccak256(abi.encodePacked(bytes32 requestHash, uint256 timestamp, bytes data)). */
export function airnodeSignedDigest(requestHash: string, timestamp: string, data: string): Uint8Array {
  const rh = fromHex(requestHash);
  if (rh.length !== 32) throw new Error('requestHash must be 32 bytes');
  if (!/^\d{1,78}$/.test(timestamp)) throw new Error('timestamp must be a decimal integer');
  const ts = new Uint8Array(32);
  let t = BigInt(timestamp);
  for (let i = 31; i >= 0; i--) {
    ts[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  const body = new TextEncoder().encode(data);
  const packed = new Uint8Array(32 + 32 + body.length);
  packed.set(rh, 0);
  packed.set(ts, 32);
  packed.set(body, 64);
  const inner = keccak_256(packed);
  const prefixed = new Uint8Array(EIP191_PREFIX.length + 32);
  prefixed.set(EIP191_PREFIX, 0);
  prefixed.set(inner, EIP191_PREFIX.length);
  return keccak_256(prefixed);
}

/** Pure check of one attestation against the request we made and the signer the listing publishes. */
export function verifyAttestation(att: Attestation, operation: string, parameters: Record<string, unknown>, expectedSigner: string): Verification {
  const expected = expectedSigner;
  const ours = airnodeRequestHash(operation, parameters);
  const requestHashMatches = ours.toLowerCase() === att.requestHash.toLowerCase();
  let signer: string | null = null;
  try {
    signer = recoverSigner(airnodeSignedDigest(att.requestHash, att.timestamp, att.data), att.signature) ?? null;
  } catch {
    signer = null;
  }
  const signerOk = signer !== null && signer.toLowerCase() === expected.toLowerCase();
  const verified = requestHashMatches && signerOk;
  const reason = verified
    ? undefined
    : !requestHashMatches
      ? 'The signature is for a different request (requestHash does not match operation and parameters)'
      : signer === null
        ? 'The signature is malformed'
        : 'The signature was not made by the address this listing publishes';
  return { verified, signer, expectedSigner: expected, requestHashMatches, ...(reason ? { reason } : {}) };
}

function toAttestation(v: unknown): Attestation | undefined {
  if (!isObj(v)) return undefined;
  const { airnode, requestHash, timestamp, data, signature } = v;
  const ts = typeof timestamp === 'number' ? String(timestamp) : timestamp;
  if (typeof airnode !== 'string' || typeof requestHash !== 'string' || typeof ts !== 'string' || typeof data !== 'string' || typeof signature !== 'string') return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(requestHash) || !/^\d{1,20}$/.test(ts) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return undefined;
  return { airnode, requestHash, timestamp: ts, data, signature };
}

function parseData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

function headersOf(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

// --- client ----------------------------------------------------------------------------------

export class AirnodeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: PaymentLogger;
  private readonly signers = new Map<string, { address: string; expires: number }>();

  constructor(private readonly deps: AirnodeClientDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? console;
  }

  /** Canonical listing URL (`https://host/`), or BAD_REQUEST. Only allow-listed AirnodeHub hosts. */
  listingUrl(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > 300) throw new ApiError('BAD_REQUEST', 'listingUrl must be a URL string');
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new ApiError('BAD_REQUEST', 'listingUrl is not a valid URL');
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
      throw new ApiError('BAD_REQUEST', 'listingUrl must be an AirnodeHub listing root, e.g. https://airnode-gleif.fly.dev/');
    }
    if (!this.deps.config.hostPattern.test(u.hostname)) throw new ApiError('BAD_REQUEST', `listingUrl host ${u.hostname} is not an allowed AirnodeHub listing`);
    return `https://${u.hostname}/`;
  }

  async call(key: AuthedApiKey, req: AirnodeCallRequest): Promise<AirnodeCallResult> {
    const url = this.listingUrl(req.listingUrl);
    const operation = this.operation(req.operation);
    const parameters = this.parameters(req.parameters);
    const maxMicro = parseUsd((req.maxPaymentUsd ?? this.deps.config.defaultMaxPaymentUsd) as string | number, 'maxPaymentUsd');
    const payFrom = req.payFromListingId === undefined || req.payFromListingId === null || req.payFromListingId === '' ? undefined : req.payFromListingId;
    if (payFrom !== undefined && typeof payFrom !== 'string') throw new ApiError('BAD_REQUEST', 'payFromListingId must be a string');

    // `call` ties the lines of one call together: an Airnode call has no task id.
    const who: Who = { target: url, op: operation, wallet: payFrom ? `listing:${payFrom}` : 'developer', listing: payFrom, call: randomUUID().slice(0, 8), dev: key.developerId };

    // Fetch the signer first: a listing we cannot read is a listing we cannot verify, so do not pay it.
    const expectedSigner = await this.signerOf(url);
    const body = JSON.stringify({ operation, parameters });
    let reply = await this.post(url, body, {});
    let payment: AirnodeCallResult['payment'] = null;

    if (reply.status === 402) {
      const requirements = this.deps.payments.parsePaymentRequired(headersOf(reply.headers), reply.json);
      this.checkAsset(requirements, who);
      const micro = atomicToMicroUsd(BigInt(requirements.amount), this.deps.config.assetDecimals);
      if (micro > maxMicro) {
        logPayment(this.log, 'warn', 'payment cap refused', { cap: 'maxPaymentUsd', requiredUsd: usd(micro), maxPaymentUsd: usd(maxMicro), ...who });
        throw new ApiError('PAYMENT_CAP', `${operation} costs $${formatUsd(micro)}, above maxPaymentUsd $${formatUsd(maxMicro)}`, { requiredUsd: formatUsd(micro), maxPaymentUsd: formatUsd(maxMicro) });
      }
      if (!(await this.deps.apiKeys.reserveSpend(key.id, micro))) {
        logPayment(this.log, 'warn', 'payment cap refused', { cap: 'keySpend', requiredUsd: usd(micro), key: key.id, ...who });
        throw new ApiError('PAYMENT_CAP', 'This payment would exceed the API key spend cap', { requiredUsd: formatUsd(micro) });
      }
      let signed;
      try {
        signed = await this.sign(key.developerId, payFrom, requirements);
      } catch (err) {
        await this.deps.apiKeys.refundSpend(key.id, micro);
        throw err;
      }
      // A transport error after this point keeps the reservation (the payment may have settled).
      reply = await this.post(url, body, signed.headers);
      const settlement = this.deps.payments.parsePaymentResponse(headersOf(reply.headers));
      const transaction = settlement?.success && settlement.transaction ? settlement.transaction : null;
      if (reply.status !== 200 && !transaction) {
        // The Airnode settles only after a successful call, so a refused or failed call cost nothing.
        await this.deps.apiKeys.refundSpend(key.id, micro);
        logPayment(this.log, 'warn', reply.status === 402 ? 'payment rejected by airnode' : 'payment not taken by airnode', { reason: this.errorText(reply.json), status: reply.status, amountUsd: usd(micro), payer: signed.payer, ...who });
        if (reply.status === 402) throw new ApiError('PAYMENT_FAILED', 'The Airnode rejected the payment', { reason: this.errorText(reply.json) });
      } else {
        payment = { amountUsd: formatUsd(micro), transaction, payer: signed.payer };
        logPayment(this.log, 'info', 'payment paid', { amountUsd: usd(micro), tx: transaction ?? 'none', payer: signed.payer, ...who });
      }
    }

    if (reply.status !== 200) this.fail(reply.status, reply.json, operation, who);
    const attestation = toAttestation(reply.json);
    if (!attestation) throw new ApiError('GATEWAY_UNAVAILABLE', 'The Airnode returned a response without a readable attestation');
    const verification = verifyAttestation(attestation, operation, parameters, expectedSigner);
    return {
      listingUrl: url,
      operation,
      parameters,
      data: parseData(attestation.data),
      attestation,
      verification,
      payment,
      signedAt: new Date(Number(attestation.timestamp) * 1000).toISOString(),
    };
  }

  /** Re-check an attestation a workflow kept, against the signer the listing publishes now. Free. */
  async verify(req: AirnodeVerifyRequest): Promise<Verification & { listingUrl: string; signedAt: string | null }> {
    const url = this.listingUrl(req.listingUrl);
    const operation = this.operation(req.operation);
    const parameters = this.parameters(req.parameters);
    const attestation = toAttestation(req.attestation);
    if (!attestation) throw new ApiError('BAD_REQUEST', 'attestation must carry airnode, requestHash, timestamp, data and signature');
    const v = verifyAttestation(attestation, operation, parameters, await this.signerOf(url));
    return { listingUrl: url, ...v, signedAt: new Date(Number(attestation.timestamp) * 1000).toISOString() };
  }

  // --- internals -----------------------------------------------------------------------------

  private operation(raw: unknown): string {
    if (typeof raw !== 'string' || !OPERATION.test(raw)) throw new ApiError('BAD_REQUEST', 'operation must be an operation name such as getLegalEntity');
    return raw;
  }

  private parameters(raw: unknown): Record<string, unknown> {
    if (raw === undefined || raw === null) return {};
    if (!isObj(raw)) throw new ApiError('BAD_REQUEST', 'parameters must be a JSON object');
    if (JSON.stringify(raw).length > 64 * 1024) throw new ApiError('BAD_REQUEST', 'parameters are too large');
    return raw;
  }

  private checkAsset(r: PaymentRequirements, who: Who): void {
    const c = this.deps.config;
    if (r.network !== c.network || r.asset.toLowerCase() !== c.asset.toLowerCase()) {
      logPayment(this.log, 'warn', 'payment refused', { reason: 'unsupported_asset', network: r.network, asset: r.asset, ...who });
      throw new ApiError('PAYMENT_FAILED', 'The Airnode asks for a token this Gateway will not pay with', { network: r.network, asset: r.asset });
    }
  }

  private async sign(developerId: string, listingId: string | undefined, requirements: PaymentRequirements): Promise<{ headers: Record<string, string>; payer: string }> {
    if (!listingId) {
      return this.deps.identity.withDeveloperKeypair(developerId, (dev) => {
        const s = this.deps.payments.signX402(dev.privateKey, requirements);
        return { headers: s.headers, payer: s.payer };
      });
    }
    const owned = await this.deps.store.getOwned(developerId, listingId);
    if (!owned) throw new ApiError('NOT_FOUND', 'payFromListingId is not one of your listings');
    const l = owned.listing;
    const agent = await this.deps.identity.getListingKeypair({ listingId: l.id, developerId: l.developerId, derivedKeyIndex: l.derivedKeyIndex });
    const s = this.deps.payments.signX402(agent.privateKey, requirements);
    return { headers: s.headers, payer: s.payer };
  }

  /** The signer address the listing publishes (`x-airnode.address` in its OpenAPI document). */
  private async signerOf(url: string): Promise<string> {
    const hit = this.signers.get(url);
    if (hit && hit.expires > this.now()) return hit.address;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(this.deps.config.timeoutMs) });
    } catch (err) {
      throw new ApiError('GATEWAY_UNAVAILABLE', 'Could not read the Airnode listing', { reason: (err as Error).message });
    }
    const doc = (await res.json().catch(() => undefined)) as unknown;
    const xa = isObj(doc) ? doc['x-airnode'] : undefined;
    const address = isObj(xa) && typeof xa.address === 'string' ? xa.address : undefined;
    if (!res.ok || !address || !isAddress(address)) throw new ApiError('GATEWAY_UNAVAILABLE', 'The Airnode listing does not publish a signer address');
    this.signers.set(url, { address, expires: this.now() + this.deps.config.docTtlMs });
    return address;
  }

  private async post(url: string, body: string, extra: Record<string, string>): Promise<{ status: number; headers: Headers; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...extra },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.deps.config.timeoutMs),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') throw new ApiError('GATEWAY_UNAVAILABLE', 'The Airnode did not answer in time');
      throw new ApiError('GATEWAY_UNAVAILABLE', 'Could not reach the Airnode', { reason: (err as Error).message });
    }
    const text = await res.text();
    if (text.length > this.deps.config.maxResponseBytes) throw new ApiError('GATEWAY_UNAVAILABLE', 'The Airnode response is too large');
    let json: unknown;
    try {
      json = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, json };
  }

  private errorText(json: unknown): string | undefined {
    if (isObj(json) && typeof json.error === 'string') return json.error.slice(0, 500);
    if (isObj(json) && isObj(json.error) && typeof json.error.message === 'string') return json.error.message.slice(0, 500);
    return undefined;
  }

  private fail(status: number, json: unknown, operation: string, who: Who): never {
    const detail = this.errorText(json);
    if (status === 400) throw new ApiError('BAD_REQUEST', `The Airnode rejected the parameters for ${operation}${detail ? `: ${detail}` : ''}`);
    if (status === 404) throw new ApiError('NOT_FOUND', `The Airnode has no operation ${operation}`);
    if (status === 402) {
      logPayment(this.log, 'warn', 'airnode still asks for payment', { reason: detail, status, ...who });
      throw new ApiError('PAYMENT_FAILED', 'The Airnode still asks for payment', { reason: detail });
    }
    throw new ApiError('GATEWAY_UNAVAILABLE', `The Airnode answered HTTP ${status}${detail ? `: ${detail}` : ''}`, { status });
  }
}

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import { PaymentProcessor, type PaymentRequirements } from '../src/services/PaymentProcessor.js';

const x402 = loadConfig({}).x402;
const payerSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const payeeSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 100);

interface Facilitator {
  verify: Record<string, unknown> | number;
  settle: Record<string, unknown> | number;
  calls: { op: string; body: { paymentPayload: unknown; paymentRequirements: unknown } }[];
}

function build(now = () => Date.now()) {
  const fac: Facilitator = { verify: { isValid: true }, settle: { success: true, transaction: '0xabc', payer: '' }, calls: [] };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const op = url.endsWith('/verify') ? 'verify' : 'settle';
    fac.calls.push({ op, body: JSON.parse(init.body as string) });
    const r = fac[op as 'verify' | 'settle'];
    if (typeof r === 'number') return new Response('boom', { status: r });
    return Response.json(r);
  }) as unknown as typeof fetch;
  const p = new PaymentProcessor({ config: x402, fetch: fetchImpl, now });
  const payTo = p.evmAddress(payeeSeed);
  const req = p.requirementsFor(payTo, '0.05');
  return { p, fac, payTo, req };
}

const headersFor = (signed: { headers: Record<string, string> }) => ({ 'payment-signature': signed.headers['PAYMENT-SIGNATURE'] });
async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected a rejection');
}

describe('PaymentProcessor keys (M2.13)', () => {
  it('derives the EVM key as SHA-256 of the Ed25519 seed', () => {
    const { p } = build();
    expect(p.deriveEvmKey(payerSeed)).toHaveLength(32);
    // address equality with viem is pinned in evm.test.ts (vectors from the SDK's signer)
    expect(p.evmAddress(payerSeed)).toBe('0x9cb17ECA0e9964b9461268e5a0728C4254e58326');
  });
  it('builds requirements in token atomic units', () => {
    const { req, payTo } = build();
    expect(req).toMatchObject({ scheme: 'exact', network: 'eip155:84532', amount: '50000', payTo, extra: { name: 'USDC', version: '2' } });
  });
});

describe('verifyX402 (M2.7)', () => {
  it('accepts a payment signed by signX402 (round trip) and calls the facilitator', async () => {
    const { p, req, fac } = build();
    const signed = p.signX402(payerSeed, req);
    expect(signed.payer).toBe(p.evmAddress(payerSeed));
    expect(signed.amountMicroUsd).toBe(50000n);
    const v = await p.verifyX402(headersFor(signed), req);
    expect(v.payer).toBe(signed.payer);
    expect(v.amountMicroUsd).toBe(50000n);
    expect(fac.calls.map((c) => c.op)).toEqual(['verify']);
  });

  it('settles through the facilitator and returns the transaction', async () => {
    const { p, req, fac } = build();
    const v = await p.verifyX402(headersFor(p.signX402(payerSeed, req)), req);
    expect(await p.settle(v)).toMatchObject({ transaction: '0xabc' });
    expect(fac.calls.map((c) => c.op)).toEqual(['verify', 'settle']);
  });

  it('answers PAYMENT_FAILED when there is no payment', async () => {
    const { p, req } = build();
    const e = await failure(p.verifyX402({}, req));
    expect(e.code).toBe('PAYMENT_FAILED');
    expect(e.status).toBe(402);
  });

  it('rejects garbage and malformed headers', async () => {
    const { p, req } = build();
    for (const bad of ['%%%', Buffer.from('{"x402Version":1}').toString('base64'), Buffer.from('not json').toString('base64')]) {
      expect((await failure(p.verifyX402({ 'payment-signature': bad }, req))).code).toBe('PAYMENT_FAILED');
    }
  });

  it('rejects a payment for the wrong amount, recipient, asset or network', async () => {
    const { p, req, payTo } = build();
    const cheap = p.requirementsFor(payTo, '0.01');
    const other = p.requirementsFor(p.evmAddress(payerSeed), '0.05');
    for (const wrong of [cheap, other, { ...req, asset: '0x' + '11'.repeat(20) }, { ...req, network: 'eip155:8453' }]) {
      const h = headersFor(p.signX402(payerSeed, wrong as PaymentRequirements));
      expect((await failure(p.verifyX402(h, req))).details).toMatchObject({ reason: 'requirements_mismatch' });
    }
  });

  it('rejects a tampered authorization (signature no longer matches)', async () => {
    const { p, req } = build();
    const h = headersFor(p.signX402(payerSeed, req));
    const doc = JSON.parse(Buffer.from(h['payment-signature'] as string, 'base64').toString());
    doc.payload.authorization.validBefore = String(Number(doc.payload.authorization.validBefore) + 1);
    const forged = { 'payment-signature': Buffer.from(JSON.stringify(doc)).toString('base64') };
    expect((await failure(p.verifyX402(forged, req))).details).toMatchObject({ reason: 'bad_signature' });
  });

  it('rejects a signature from someone other than `from`', async () => {
    const { p, req } = build();
    const mine = JSON.parse(Buffer.from(headersFor(p.signX402(payerSeed, req))['payment-signature'] as string, 'base64').toString());
    const theirs = JSON.parse(Buffer.from(headersFor(p.signX402(payeeSeed, req))['payment-signature'] as string, 'base64').toString());
    mine.payload.signature = theirs.payload.signature;
    const forged = { 'payment-signature': Buffer.from(JSON.stringify(mine)).toString('base64') };
    expect((await failure(p.verifyX402(forged, req))).details).toMatchObject({ reason: 'bad_signature' });
  });

  it('rejects an expired authorization and one that is not valid yet', async () => {
    const t = { now: Date.now() };
    const { p, req } = build(() => t.now);
    const signed = p.signX402(payerSeed, req);
    t.now += 3_600_000;
    expect((await failure(p.verifyX402(headersFor(signed), req))).details).toMatchObject({ reason: 'expired' });
    t.now -= 7_200_000;
    expect((await failure(p.verifyX402(headersFor(signed), req))).details).toMatchObject({ reason: 'not_yet_valid' });
  });

  it('rejects a replayed authorization while the first is in flight, and allows it again after release', async () => {
    const { p, req } = build();
    const h = headersFor(p.signX402(payerSeed, req));
    const first = await p.verifyX402(h, req);
    expect((await failure(p.verifyX402(h, req))).details).toMatchObject({ reason: 'replayed' });
    p.release(first);
    await expect(p.verifyX402(h, req)).resolves.toBeTruthy();
  });

  it('turns a facilitator rejection into PAYMENT_FAILED and frees the nonce', async () => {
    const { p, req, fac } = build();
    const h = headersFor(p.signX402(payerSeed, req));
    fac.verify = { isValid: false, invalidReason: 'insufficient_funds' };
    const e = await failure(p.verifyX402(h, req));
    expect(e.code).toBe('PAYMENT_FAILED');
    expect(e.details).toMatchObject({ reason: 'insufficient_funds' });
    fac.verify = { isValid: true };
    await expect(p.verifyX402(h, req)).resolves.toBeTruthy();
  });

  it('reports a broken facilitator as GATEWAY_UNAVAILABLE, not as a bad payment', async () => {
    const { p, req, fac } = build();
    fac.verify = 503;
    expect((await failure(p.verifyX402(headersFor(p.signX402(payerSeed, req)), req))).code).toBe('GATEWAY_UNAVAILABLE');
  });

  it('fails settlement cleanly', async () => {
    const { p, req, fac } = build();
    const v = await p.verifyX402(headersFor(p.signX402(payerSeed, req)), req);
    fac.settle = { success: false, errorReason: 'nonce_used' };
    const e = await failure(p.settle(v));
    expect(e.code).toBe('PAYMENT_FAILED');
    expect(e.details).toMatchObject({ reason: 'nonce_used' });
  });
});

describe('outbound helpers (M2.13)', () => {
  it('reads requirements from the PAYMENT-REQUIRED header, preferring the configured network', () => {
    const { p, req } = build();
    const other = { ...req, network: 'eip155:8453' };
    const header = p.paymentRequiredHeader(req, 'https://x/a/zns:1');
    // header carries a single option
    expect(p.parsePaymentRequired({ 'payment-required': header }, undefined)).toEqual(req);
    const body = { x402Version: 2, accepts: [other, req] };
    expect(p.parsePaymentRequired({}, body).network).toBe('eip155:84532');
  });

  it('refuses x402 v1 and unsupported schemes', () => {
    const { p, req } = build();
    expect(() => p.parsePaymentRequired({}, { x402Version: 1, accepts: [req] })).toThrow(/v2/);
    expect(() => p.parsePaymentRequired({}, { x402Version: 2, accepts: [{ ...req, scheme: 'upto' }] })).toThrow(/no payment scheme/);
    expect(() => p.parsePaymentRequired({}, { x402Version: 2, accepts: [{ ...req, network: 'solana:mainnet' }] })).toThrow(/no payment scheme/);
  });

  it('will not sign for a malformed recipient', () => {
    const { p, req } = build();
    expect(() => p.signX402(payerSeed, { ...req, payTo: 'not-an-address' })).toThrow(/invalid address/);
  });

  it('reads the settlement header', () => {
    const { p } = build();
    const header = Buffer.from(JSON.stringify({ success: true, transaction: '0xfeed' })).toString('base64');
    expect(p.parsePaymentResponse({ 'payment-response': header })).toEqual({ success: true, transaction: '0xfeed' });
    expect(p.parsePaymentResponse({})).toBeUndefined();
    expect(p.parsePaymentResponse({ 'payment-response': '%%' })).toBeUndefined();
  });
});

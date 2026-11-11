// AirnodeHub calls for n8n (Zynd x AirnodeHub showcase): request hash and signature checks against a
// real captured response, then the paid call flow through the real app against a fake Airnode.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { airnodeRequestHash, verifyAttestation, airnodeSignedDigest, type Attestation } from '../src/services/AirnodeClient.js';
import { fromHex, privateKeyToAddress, recoverSigner, signDigest, transferAuthorizationDigest } from '../src/services/evm.js';
import { keypairFromSeed } from '../src/services/IdentityService.js';
import { API_KEY, captureLog, DEV, devSeed, makeGateway, type Gateway } from './helpers/harness.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/airnode-briefpixel.json', import.meta.url), 'utf8')) as {
  listingSigner: string;
  operation: string;
  parameters: Record<string, unknown>;
  attestation: Attestation;
};

describe('attestation (x-airnode 0.2.0) against a real AirnodeHub response', () => {
  it('recomputes the request hash from operation and parameters', () => {
    expect(airnodeRequestHash(fixture.operation, fixture.parameters)).toBe(fixture.attestation.requestHash);
    // parameter order does not matter: entries are sorted by name
    expect(airnodeRequestHash(fixture.operation, { category: 'finance', language: 'en' })).toBe(fixture.attestation.requestHash);
  });

  it('verifies the signature against the address the listing publishes', () => {
    const v = verifyAttestation(fixture.attestation, fixture.operation, fixture.parameters, fixture.listingSigner);
    expect(v).toMatchObject({ verified: true, requestHashMatches: true });
    expect(v.signer?.toLowerCase()).toBe(fixture.listingSigner.toLowerCase());
  });

  it('fails when one byte of the data changes', () => {
    const tampered = { ...fixture.attestation, data: fixture.attestation.data.replace('Briefpixel', 'Briefpixe1') };
    const v = verifyAttestation(tampered, fixture.operation, fixture.parameters, fixture.listingSigner);
    expect(v.verified).toBe(false);
    expect(v.reason).toMatch(/not made by the address/);
  });

  it('fails when the answer is for different parameters', () => {
    const v = verifyAttestation(fixture.attestation, fixture.operation, { language: 'de', category: 'finance' }, fixture.listingSigner);
    expect(v).toMatchObject({ verified: false, requestHashMatches: false });
  });

  it('fails when someone else signed it, even if the envelope names them', () => {
    const v = verifyAttestation(fixture.attestation, fixture.operation, fixture.parameters, '0x0000000000000000000000000000000000000001');
    expect(v.verified).toBe(false);
  });

  it('sorts nested objects by name and keeps arrays in order', () => {
    const a = airnodeRequestHash('op', { b: [{ y: 1, x: 2 }, 3], a: { d: 1, c: 2 } });
    const b = airnodeRequestHash('op', { a: { c: 2, d: 1 }, b: [{ x: 2, y: 1 }, 3] });
    expect(a).toBe(b);
    expect(airnodeRequestHash('op', { b: [3, { x: 2, y: 1 }], a: { c: 2, d: 1 } })).not.toBe(a);
  });
});

// --- fake Airnode ------------------------------------------------------------------------------

const AIRNODE_KEY = fromHex('0x' + '11'.repeat(32));
const AIRNODE_ADDRESS = privateKeyToAddress(AIRNODE_KEY);
const URL_OK = 'https://airnode-test.fly.dev/';
const AUSD = '0xbeA34973e5f67F18F656A2C6070C64326C791808';
const PAY_TO = '0x1505FD562AC2Fb4307B85BC6c672FfeafB4d57A7';

interface FakeOpts {
  price?: string; // atomic aUSD; unset = free
  asset?: string;
  signWith?: Uint8Array;
  status?: number;
  settle?: boolean;
}

function fakeAirnode(o: FakeOpts = {}) {
  const seen: { method: string; url: string; paid: boolean; payment?: Record<string, unknown> }[] = [];
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const sig = headers.get('PAYMENT-SIGNATURE');
    const payment = sig ? (JSON.parse(Buffer.from(sig, 'base64').toString()) as Record<string, unknown>) : undefined;
    seen.push({ method, url, paid: !!sig, payment });
    if (method === 'GET') return Response.json({ openapi: '3.1.0', 'x-airnode': { address: AIRNODE_ADDRESS, version: '0.2.0' } });
    const { operation, parameters } = JSON.parse(String(init?.body)) as { operation: string; parameters: Record<string, unknown> };
    if (o.status) return Response.json({ error: 'upstream exploded' }, { status: o.status });
    if (o.price && !sig) {
      const required = { x402Version: 2, error: 'Payment required', accepts: [{ scheme: 'exact', network: 'eip155:84532', amount: o.price, asset: o.asset ?? AUSD, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'AirnodeHub USD', version: '1' } }] };
      return Response.json({ error: 'Payment required' }, { status: 402, headers: { 'PAYMENT-REQUIRED': b64(required) } });
    }
    const requestHash = airnodeRequestHash(operation, parameters);
    const timestamp = '1794388576';
    const data = JSON.stringify({ ok: true, operation, echo: parameters });
    const signature = signDigest(o.signWith ?? AIRNODE_KEY, airnodeSignedDigest(requestHash, timestamp, data));
    const extra: Record<string, string> = sig && o.settle !== false ? { 'PAYMENT-RESPONSE': b64({ success: true, transaction: '0xairnodetx' }) } : {};
    return Response.json({ airnode: AIRNODE_ADDRESS, requestHash, timestamp, data, signature }, { headers: extra });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

/** The EVM address that signed an x402 payment (recovered from its EIP-3009 authorization). */
function payerOf(payment: Record<string, unknown>): string {
  const p = payment as { accepted: { extra: { name: string; version: string }; asset: string }; payload: { signature: string; authorization: Record<string, string> } };
  const a = p.payload.authorization;
  const digest = transferAuthorizationDigest(
    { name: p.accepted.extra.name, version: p.accepted.extra.version, chainId: 84532n, verifyingContract: p.accepted.asset },
    { from: a.from as string, to: a.to as string, value: BigInt(a.value as string), validAfter: BigInt(a.validAfter as string), validBefore: BigInt(a.validBefore as string), nonce: a.nonce as string },
  );
  return recoverSigner(digest, p.payload.signature) as string;
}

let gw: Gateway;
afterEach(async () => {
  await gw?.close();
});

async function setup(o: FakeOpts = {}, extra: { log?: ReturnType<typeof captureLog>; wrap?: (f: typeof fetch) => typeof fetch } = {}) {
  const airnode = fakeAirnode(o);
  gw = await makeGateway({ airnodeFetch: extra.wrap ? extra.wrap(airnode.fetchImpl) : airnode.fetchImpl, ...(extra.log ? { log: extra.log } : {}) });
  const keyId = [...gw.apiKeys.rows.values()].find((r) => r.developerId === DEV)!.id;
  const call = (body: Record<string, unknown>) => gw.post('/n8n/v1/airnode/call', { listingUrl: URL_OK, operation: 'getThing', parameters: { id: 'x1' }, ...body }, API_KEY);
  return { airnode, call, keyId };
}

describe('POST /n8n/v1/airnode/call', () => {
  it('free operation: returns parsed data, the attestation and a passing verification', async () => {
    const { call, airnode } = await setup();
    const res = await call({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ listingUrl: URL_OK, operation: 'getThing', data: { ok: true, echo: { id: 'x1' } }, payment: null, verification: { verified: true, requestHashMatches: true } });
    expect(res.body.verification.expectedSigner).toBe(AIRNODE_ADDRESS);
    expect(typeof res.body.attestation.data).toBe('string');
    expect(airnode.seen.map((s) => s.method)).toEqual(['GET', 'POST']);
  });

  it('priced operation: pays from the developer wallet, records spend, returns the settlement', async () => {
    const { call, airnode, keyId } = await setup({ price: '10000' });
    const res = await call({ maxPaymentUsd: '0.02' });
    expect(res.status).toBe(200);
    expect(res.body.payment).toMatchObject({ amountUsd: '0.010000', transaction: '0xairnodetx' });
    const paid = airnode.seen.find((s) => s.paid)!;
    const devAddress = gw.payments.evmAddress(keypairFromSeed(devSeed).privateKey);
    expect(payerOf(paid.payment!)).toBe(devAddress);
    expect(res.body.payment.payer).toBe(devAddress);
    expect(gw.apiKeys.spent(keyId)).toBe(10_000n);
    expect(res.body.verification.verified).toBe(true);
  });

  it('payFromListingId: pays from that listing’s own wallet', async () => {
    const { call, airnode } = await setup({ price: '10000' });
    const res = await call({ payFromListingId: gw.listing.id });
    expect(res.status).toBe(200);
    const row = gw.store.listings.get(gw.listing.id)!;
    const agent = await gw.identity.getListingKeypair({ listingId: row.id, developerId: DEV, derivedKeyIndex: row.derivedKeyIndex });
    const listingWallet = gw.payments.evmAddress(agent.privateKey);
    expect(payerOf(airnode.seen.find((s) => s.paid)!.payment!)).toBe(listingWallet);
    expect(res.body.payment.payer).toBe(listingWallet);
  });

  it('refuses a listing that is not the caller’s', async () => {
    const { call, keyId } = await setup({ price: '10000' });
    const res = await call({ payFromListingId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(404);
    expect(gw.apiKeys.spent(keyId)).toBe(0n); // reservation refunded
  });

  it('refuses a price above maxPaymentUsd before signing anything', async () => {
    const { call, airnode } = await setup({ price: '50000' });
    const res = await call({ maxPaymentUsd: '0.01' });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('PAYMENT_CAP');
    expect(airnode.seen.some((s) => s.paid)).toBe(false);
  });

  it('refuses to pay in any token but the configured aUSD', async () => {
    const { call, airnode } = await setup({ price: '10000', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' });
    const res = await call({});
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('PAYMENT_FAILED');
    expect(airnode.seen.some((s) => s.paid)).toBe(false);
  });

  it('flags an answer signed by a key the listing does not publish', async () => {
    const { call } = await setup({ signWith: fromHex('0x' + '22'.repeat(32)) });
    const res = await call({});
    expect(res.status).toBe(200);
    expect(res.body.verification).toMatchObject({ verified: false });
  });

  it('rejects hosts outside AirnodeHub (no SSRF)', async () => {
    const { call, airnode } = await setup();
    for (const listingUrl of ['https://evil.example.com/', 'http://airnode-test.fly.dev/', 'https://airnode-test.fly.dev/api/x', 'https://169.254.169.254/']) {
      const res = await call({ listingUrl });
      expect(res.status, listingUrl).toBe(400);
    }
    expect(airnode.seen).toHaveLength(0);
  });

  it('maps an upstream failure to 502 and charges nothing', async () => {
    const { call, keyId } = await setup({ status: 502 });
    const res = await call({});
    expect(res.status).toBe(502);
    expect(gw.apiKeys.spent(keyId)).toBe(0n);
  });
});

describe('POST /n8n/v1/airnode/verify', () => {
  it('re-verifies a kept attestation and catches tampering', async () => {
    const { call } = await setup();
    const first = await call({});
    const body = { listingUrl: URL_OK, operation: 'getThing', parameters: { id: 'x1' }, attestation: first.body.attestation };
    const ok = await gw.post('/n8n/v1/airnode/verify', body, API_KEY);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ verified: true, listingUrl: URL_OK });
    const bad = await gw.post('/n8n/v1/airnode/verify', { ...body, attestation: { ...first.body.attestation, data: '{"ok":false}' } }, API_KEY);
    expect(bad.body.verified).toBe(false);
  });
});

describe('Airnode payment log lines', () => {
  const AIRNODE = 'https://airnode-test.fly.dev/';

  it('paid call: one info line with target, operation, amount, tx, payer and wallet', async () => {
    const log = captureLog();
    const { call, keyId } = await setup({ price: '10000' }, { log });
    const res = await call({});
    expect(res.status).toBe(200);
    expect(log.entries.map((e) => e.level)).toEqual(['info']);
    const devAddress = gw.payments.evmAddress(keypairFromSeed(devSeed).privateKey);
    expect(log.lines[0]).toMatch(new RegExp(`^payment paid amountUsd=0.01 tx=0xairnodetx payer=${devAddress} target=${AIRNODE} op=getThing wallet=developer call=[0-9a-f]{8} dev=${DEV}$`));
    expect(log.lines.join('\n')).not.toContain(API_KEY);
    expect(gw.apiKeys.spent(keyId)).toBe(10_000n);
  });

  it('payFromListingId: names the listing wallet', async () => {
    const log = captureLog();
    const { call } = await setup({ price: '10000' }, { log });
    await call({ payFromListingId: gw.listing.id });
    expect(log.lines[0]).toContain(`wallet=listing:${gw.listing.id} listing=${gw.listing.id}`);
  });

  it('a free operation logs nothing', async () => {
    const log = captureLog();
    const { call } = await setup({}, { log });
    expect((await call({})).status).toBe(200);
    expect(log.entries).toEqual([]);
  });

  it('a price above maxPaymentUsd is logged with required vs ceiling', async () => {
    const log = captureLog();
    const { call } = await setup({ price: '50000' }, { log });
    const res = await call({ maxPaymentUsd: '0.01' });
    expect(res.body.code).toBe('PAYMENT_CAP'); // unchanged
    expect(log.entries[0]?.level).toBe('warn');
    expect(log.lines[0]).toMatch(/^payment cap refused cap=maxPaymentUsd requiredUsd=0.05 maxPaymentUsd=0.01 target=\S+ op=getThing wallet=developer call=[0-9a-f]{8} dev=/);
  });

  it('the key spend cap is logged', async () => {
    const log = captureLog();
    const { call, keyId } = await setup({ price: '50000' }, { log });
    gw.apiKeys.rows.get(keyId)!.spendCapUsd = '0.01';
    const res = await call({ maxPaymentUsd: '0.10' });
    expect(res.body.code).toBe('PAYMENT_CAP');
    expect(log.lines[0]).toContain(`payment cap refused cap=keySpend requiredUsd=0.05 key=${keyId}`);
  });

  it('a token the Gateway will not pay with is logged as refused', async () => {
    const log = captureLog();
    const { call } = await setup({ price: '10000', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }, { log });
    const res = await call({});
    expect(res.body.code).toBe('PAYMENT_FAILED');
    expect(log.lines[0]).toContain('payment refused reason=unsupported_asset network=eip155:84532 asset=0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });

  it('an Airnode that rejects the payment: logs its reason, charges nothing, error unchanged', async () => {
    const log = captureLog();
    const { call, keyId } = await setup(
      { price: '10000' },
      { log, wrap: (f) => (async (url: string, init?: RequestInit) => (new Headers(init?.headers).get('PAYMENT-SIGNATURE') ? Response.json({ error: 'insufficient funds' }, { status: 402 }) : f(url, init))) as unknown as typeof fetch },
    );
    const res = await call({});
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: 'PAYMENT_FAILED', error: 'The Airnode rejected the payment', details: { reason: 'insufficient funds' } });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]?.level).toBe('warn');
    expect(log.lines[0]).toMatch(/^payment rejected by airnode reason="insufficient funds" status=402 amountUsd=0.01 payer=0x\w{40} target=\S+ op=getThing/);
    expect(gw.apiKeys.spent(keyId)).toBe(0n);
  });

  it('an Airnode that fails the paid call with a 5xx: logged as not taken', async () => {
    const log = captureLog();
    const { call } = await setup({ price: '10000' }, { log, wrap: (f) => (async (url: string, init?: RequestInit) => (new Headers(init?.headers).get('PAYMENT-SIGNATURE') ? Response.json({ error: 'upstream exploded' }, { status: 500 }) : f(url, init))) as unknown as typeof fetch });
    expect((await call({})).status).toBe(502);
    expect(log.lines[0]).toContain('payment not taken by airnode reason="upstream exploded" status=500');
  });
});

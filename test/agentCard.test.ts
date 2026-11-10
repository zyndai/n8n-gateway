// Agent card at entity_url (G20) and per-listing pricing (G17), M2.19.
import { ed25519 } from '@noble/curves/ed25519.js';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/services/canonical.js';
import { effectivePriceUsd } from '../src/services/money.js';
import type { PaymentRequirements } from '../src/services/PaymentProcessor.js';
import { DEV, devSeed, makeGateway, type Gateway } from './helpers/harness.js';
import { keypairFromSeed } from '../src/services/IdentityService.js';
import { inMinutes, mintToken } from './helpers/jwt.js';

let gw: Gateway;
afterEach(async () => {
  await gw?.close();
});

const decode = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const cardPath = (id: string) => `/a/${encodeURIComponent(id)}/.well-known/agent-card.json`;

describe('agent card', () => {
  it('is served at entity_url and points SDK clients at the A2A endpoint', async () => {
    gw = await makeGateway({ price: '0.05' });
    const res = await request(gw.app).get(cardPath(gw.entityId));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age');
    // The SDK resolves `${entity_url}/.well-known/agent-card.json`, then calls card.url.
    expect(gw.listing.entityUrl).toBe(`https://gw.test/a/${gw.entityId}`);
    expect(res.body).toMatchObject({
      protocolVersion: '0.3.0',
      name: 'Weather',
      description: 'Forecasts',
      url: `https://gw.test/a/${gw.entityId}/a2a/v1`,
      preferredTransport: 'JSONRPC',
      skills: [{ id: 'default', name: 'Weather' }],
    });
    expect(res.body['x-zynd']).toMatchObject({
      entityId: gw.entityId,
      status: 'online',
      category: 'general',
      pricing: { model: 'per-request', currency: 'USD', rates: { default: 0.05 }, paymentMethods: ['x402'] },
    });
  });

  it('is signed by the listing key (detached JWS over the JCS body) and carries the wallet and developer proof', async () => {
    gw = await makeGateway();
    const card = (await request(gw.app).get(cardPath(gw.entityId))).body;
    const agent = await gw.identity.getListingKeypair({ listingId: gw.listing.id, developerId: DEV, derivedKeyIndex: gw.listing.derivedKeyIndex });

    const [sig] = card.signatures;
    expect(JSON.parse(unb64url(sig.protected).toString())).toEqual({ alg: 'EdDSA', typ: 'agent-card+jcs+jws' });
    expect(sig.header.kid).toBe(card['x-zynd'].publicKey);
    const { signatures: _s, ...body } = card;
    const input = new TextEncoder().encode(`${sig.protected}.${canonicalJson(body)}`);
    expect(ed25519.verify(unb64url(sig.signature), input, agent.publicKey)).toBe(true);

    // Tampering breaks it.
    const forged = new TextEncoder().encode(`${sig.protected}.${canonicalJson({ ...body, name: 'Evil' })}`);
    expect(ed25519.verify(unb64url(sig.signature), forged, agent.publicKey)).toBe(false);

    expect(card['x-zynd'].walletAddress).toBe(gw.payments.evmAddress(agent.privateKey));
    const proof = card['x-zynd'].developerProof;
    expect(proof.entity_index).toBe(gw.listing.derivedKeyIndex);
    expect(proof.developer_public_key).toBe(`ed25519:${Buffer.from(keypairFromSeed(devSeed).publicKey).toString('base64')}`);
  });

  it('advertises no pricing for a free listing and offline once deactivated', async () => {
    gw = await makeGateway();
    expect((await request(gw.app).get(cardPath(gw.entityId))).body['x-zynd'].pricing).toBeUndefined();
    await gw.listings.deactivate(DEV, gw.listing.id);
    expect((await request(gw.app).get(cardPath(gw.entityId))).body['x-zynd'].status).toBe('offline');
  });

  it('404s for an unknown entity and for a listing that never registered', async () => {
    gw = await makeGateway();
    expect((await request(gw.app).get(cardPath('zns:nope'))).status).toBe(404);
    const draft = await gw.listings.create(DEV, { name: 'Draft', summary: 's', category: 'c', tags: [] });
    expect(draft.entityId).toBeNull();
  });
});

describe('per-listing price (G17)', () => {
  it('effectivePriceUsd: the listing wins, null falls back, zero is free', () => {
    expect(effectivePriceUsd(null, '0.05')).toBe('0.05');
    expect(effectivePriceUsd('0.020000', '0.05')).toBe('0.020000');
    expect(effectivePriceUsd('0', '0.05')).toBeUndefined();
    expect(effectivePriceUsd('0.000000', '0.05')).toBeUndefined();
    expect(effectivePriceUsd(null, undefined)).toBeUndefined();
    expect(() => effectivePriceUsd('abc', undefined)).toThrow();
  });

  it('charges the listing\'s own price even when the Gateway default is unset', async () => {
    gw = await makeGateway();
    await gw.listings.setPrice(DEV, gw.listing.id, '0.02');
    const res = await gw.send();
    expect(res.status).toBe(402);
    const [req] = decode(res.headers['payment-required'] as string).accepts as PaymentRequirements[];
    expect(req?.amount).toBe('20000');
    const card = (await request(gw.app).get(cardPath(gw.entityId))).body;
    expect(card['x-zynd'].pricing.rates.default).toBe(0.02);
  });

  it('overrides the Gateway default, and null reverts to it', async () => {
    gw = await makeGateway({ price: '0.05' });
    await gw.listings.setPrice(DEV, gw.listing.id, '0.01');
    const amount = async () => (decode((await gw.send()).headers['payment-required'] as string).accepts as PaymentRequirements[])[0]?.amount;
    expect(await amount()).toBe('10000');
    await gw.listings.setPrice(DEV, gw.listing.id, null);
    expect(await amount()).toBe('50000');
  });

  it('"0" makes one listing free under a paid default', async () => {
    gw = await makeGateway({ price: '0.05' });
    await gw.listings.setPrice(DEV, gw.listing.id, '0');
    const pending = gw.send();
    const job = await gw.waitForJob();
    await gw.post(`/n8n/v1/jobs/${job.payload.jobId}/complete`, { output: 'ok' });
    expect((await pending).status).toBe(200);
    expect(gw.fac.calls).toEqual([]);
  });

  it('rejects an invalid price and another developer\'s listing', async () => {
    gw = await makeGateway();
    await expect(gw.listings.setPrice(DEV, gw.listing.id, '-1')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(gw.listings.setPrice(DEV, gw.listing.id, '0.0000001')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(gw.listings.setPrice('zns:dev:other', gw.listing.id, '1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('dashboard: create with a price, PATCH it, reject bad input', async () => {
    gw = await makeGateway();
    const auth = { Authorization: `Bearer ${mintToken({ sub: DEV, exp: inMinutes(5) }, { secret: 'x'.repeat(40) })}` };
    const body = { name: 'P', summary: 's', category: 'c', tags: [] };
    const created = await request(gw.app).post('/internal/v1/listings').set(auth).send({ ...body, priceUsd: '0.25' });
    expect(created.status).toBe(201);
    expect(created.body.priceUsd).toBe('0.25');
    expect((await request(gw.app).post('/internal/v1/listings').set(auth).send({ ...body, priceUsd: 'free' })).status).toBe(400);
    expect((await request(gw.app).post('/internal/v1/listings').set(auth).send({ ...body, priceUsd: null })).status).toBe(400);

    const patched = await request(gw.app).patch(`/internal/v1/listings/${created.body.id}`).set(auth).send({ priceUsd: 0.5 });
    expect(Number(patched.body.priceUsd)).toBe(0.5); // Postgres returns numeric(18,6) as '0.500000'
    const reset = await request(gw.app).patch(`/internal/v1/listings/${created.body.id}`).set(auth).send({ priceUsd: null });
    expect(reset.body.priceUsd).toBeNull();
    expect((await request(gw.app).patch(`/internal/v1/listings/${created.body.id}`).set(auth).send({})).status).toBe(400);
    expect((await request(gw.app).patch('/internal/v1/listings/missing').set(auth).send({ priceUsd: '1' })).status).toBe(404);
  });
});

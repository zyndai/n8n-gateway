// Inbound paid calls with x402 (M2.7, M2.9): an external agent pays, the Gateway runs the job in
// n8n and settles only if the job succeeds.
import { afterEach, describe, expect, it } from 'vitest';
import type { PaymentRequirements } from '../src/services/PaymentProcessor.js';
import { DEV, makeGateway, type Gateway } from './helpers/harness.js';

let gw: Gateway;
afterEach(async () => {
  await gw?.close();
});

const payerSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const decode = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

/** What an external agent does: call, read the 402, sign, call again. */
async function challenge(): Promise<PaymentRequirements> {
  const res = await gw.send();
  expect(res.status).toBe(402);
  return decode(res.headers['payment-required'] as string).accepts[0];
}
const pay = (req: PaymentRequirements) => ({ 'PAYMENT-SIGNATURE': gw.payments.signX402(payerSeed, req).headers['PAYMENT-SIGNATURE'] as string });

describe('paid listing', () => {
  it('answers an unpaid call with 402 and the exact price, payable to the listing\'s own address', async () => {
    gw = await makeGateway({ price: '0.05' });
    const res = await gw.send();
    expect(res.status).toBe(402);
    expect(res.body.error.data.code).toBe('PAYMENT_FAILED');
    const header = decode(res.headers['payment-required'] as string);
    expect(header).toMatchObject({ x402Version: 2, resource: { url: `https://gw.test/a/${gw.entityId}` } });
    const [req] = header.accepts as PaymentRequirements[];
    const kp = await gw.identity.getListingKeypair({ listingId: gw.listing.id, developerId: DEV, derivedKeyIndex: gw.listing.derivedKeyIndex });
    expect(req).toMatchObject({ scheme: 'exact', amount: '50000', payTo: gw.payments.evmAddress(kp.privateKey) });
    expect(gw.jobs).toHaveLength(0);
    expect(gw.tasks.rows.size).toBe(0);
  });

  it('runs the whole paid flow: pay -> n8n -> jobs/complete -> A2A result, settling after success', async () => {
    gw = await makeGateway({ price: '0.05' });
    const req = await challenge();
    const pending = gw.send({ headers: pay(req) });
    const job = await gw.waitForJob();
    expect(gw.fac.calls).toEqual(['verify']); // verified up front, not yet settled

    await gw.post(`/n8n/v1/jobs/${job.payload.jobId}/complete`, { output: { forecast: 'sunny' } });
    const res = await pending;

    expect(res.status).toBe(200);
    expect(res.body.result.status.state).toBe('completed');
    expect(res.body.result.artifacts[0].parts[0].data).toEqual({ forecast: 'sunny' });
    expect(res.body.result.metadata).toEqual({ paymentTxn: '0xsettled' });
    expect(decode(res.headers['payment-response'] as string)).toMatchObject({ success: true, transaction: '0xsettled' });
    expect(gw.fac.calls).toEqual(['verify', 'settle']);
    expect(gw.tasks.rows.get(job.payload.jobId)).toMatchObject({ paymentTxn: '0xsettled', paymentUsd: '0.050000' });
  });

  it('does not settle when the workflow fails the job, and the proof can be reused', async () => {
    gw = await makeGateway({ price: '0.05' });
    const req = await challenge();
    const headers = pay(req);
    const pending = gw.send({ headers });
    const job = await gw.waitForJob();
    await gw.post(`/n8n/v1/jobs/${job.payload.jobId}/complete`, { error: 'boom' });
    const res = await pending;
    expect(res.body.result.status.state).toBe('failed');
    expect(res.headers['payment-response']).toBeUndefined();
    expect(gw.fac.calls).toEqual(['verify']);

    // nothing was charged, so the same authorization is accepted again
    gw.n8n.respond = (_j, r) => void r.writeHead(200, { 'Content-Type': 'application/json' }).end('{"output":"ok"}');
    const retry = await gw.send({ headers });
    expect(retry.status).toBe(200);
    expect(gw.fac.calls).toEqual(['verify', 'verify', 'settle']);
  });

  it('does not settle a timed-out job', async () => {
    gw = await makeGateway({ price: '0.05', timeoutMs: 120, pollIntervalMs: 20 });
    const req = await challenge();
    const res = await gw.send({ headers: pay(req) });
    expect(res.status).toBe(504);
    expect(gw.fac.calls).toEqual(['verify']);
  });

  it('does not settle a cancelled job', async () => {
    gw = await makeGateway({ price: '0.05' });
    const req = await challenge();
    const pending = gw.send({ headers: pay(req) });
    const job = await gw.waitForJob();
    const { default: request } = await import('supertest');
    await request(gw.app).post(`/a/${encodeURIComponent(gw.entityId)}/a2a/v1`).send(gw.rpc('tasks/cancel', { id: job.payload.jobId }));
    expect((await pending).body.result.status.state).toBe('canceled');
    expect(gw.fac.calls).toEqual(['verify']);
  });

  it('rejects a payment for the wrong amount with 402, a fresh challenge and no side effects', async () => {
    gw = await makeGateway({ price: '0.05' });
    const req = await challenge();
    const cheap = { ...req, amount: '10000' };
    const res = await gw.send({ headers: pay(cheap) });
    expect(res.status).toBe(402);
    expect(res.body.error.data.details).toMatchObject({ reason: 'requirements_mismatch' });
    expect(decode(res.headers['payment-required'] as string).accepts[0].amount).toBe('50000');
    expect(gw.jobs).toHaveLength(0);
    expect(gw.tasks.rows.size).toBe(0);
    expect(gw.fac.calls).toEqual([]);
  });

  it('rejects a payment the facilitator refuses', async () => {
    gw = await makeGateway({ price: '0.05' });
    const req = await challenge();
    gw.fac.verify = { isValid: false, invalidReason: 'insufficient_funds' };
    const res = await gw.send({ headers: pay(req) });
    expect(res.status).toBe(402);
    expect(res.body.error.data.details).toMatchObject({ reason: 'insufficient_funds' });
    expect(gw.jobs).toHaveLength(0);
  });

  it('answers 402 PAYMENT_FAILED if settlement fails after the job succeeded', async () => {
    gw = await makeGateway({ price: '0.05' });
    const req = await challenge();
    gw.fac.settle = { success: false, errorReason: 'nonce_used' };
    gw.n8n.respond = (_j, r) => void r.writeHead(200, { 'Content-Type': 'application/json' }).end('{"output":"ok"}');
    const res = await gw.send({ headers: pay(req) });
    expect(res.status).toBe(402);
    expect(res.body.error.data.details).toMatchObject({ reason: 'nonce_used' });
  });

  it('does not forward a job when the facilitator is down (502, no charge)', async () => {
    gw = await makeGateway({ price: '0.05' });
    const req = await challenge();
    gw.fac.verify = null as unknown as Record<string, unknown>; // unreadable body
    const res = await gw.send({ headers: pay(req) });
    expect(res.status).toBe(502);
    expect(gw.jobs).toHaveLength(0);
  });
});

describe('free listing', () => {
  it('ignores payment headers entirely', async () => {
    gw = await makeGateway();
    gw.n8n.respond = (_j, r) => void r.writeHead(200, { 'Content-Type': 'application/json' }).end('{"output":"ok"}');
    const res = await gw.send({ headers: { 'PAYMENT-SIGNATURE': 'garbage' } });
    expect(res.status).toBe(200);
    expect(gw.fac.calls).toEqual([]);
  });
});

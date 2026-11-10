// M2.20: a payment is verified up front and settled after the job COMPLETED. These tests cover the
// crash window in between: the sealed proof on the task, and the sweep that settles or releases it.
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors.js';
import { PaymentProofVault, PaymentRecovery, type PaymentRecoveryDeps } from '../src/services/PaymentRecovery.js';
import type { PaymentRequirements, VerifiedPayment } from '../src/services/PaymentProcessor.js';
import { DEV, makeGateway, masterKey, type Gateway } from './helpers/harness.js';

let gw: Gateway;
afterEach(async () => {
  await gw?.close();
});

const payerSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const vault = new PaymentProofVault(masterKey);
const decode = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

/** A real verified payment for the listing, as the Gateway holds it just before running the job. */
async function verified(): Promise<VerifiedPayment> {
  const challenge = await gw.send();
  const req = decode(challenge.headers['payment-required'] as string).accepts[0] as PaymentRequirements;
  const headers = gw.payments.signX402(payerSeed, req).headers;
  return gw.payments.verifyX402({ 'payment-signature': headers['PAYMENT-SIGNATURE'] }, req);
}

/** A task as a crashed Gateway would have left it: proof stored, status as given. */
async function orphan(status: 'COMPLETED' | 'FAILED' | 'CANCELED' | 'PROCESSING', v?: VerifiedPayment) {
  const proof = v ?? (await verified());
  const t = await gw.tasks.create({ developerId: DEV, listingId: gw.listing.id, direction: 'INBOUND', input: {}, paymentUsd: '0.050000', paymentProofEnc: vault.seal(proof) });
  if (status === 'COMPLETED') await gw.tasks.transition(t.id, ['PENDING'], 'COMPLETED', { output: 'done' });
  else if (status !== 'PROCESSING') await gw.tasks.transition(t.id, ['PENDING'], status);
  else await gw.tasks.transition(t.id, ['PENDING'], 'PROCESSING');
  return t.id;
}

const later = (ms: number) => () => Date.now() + ms;
function recovery(over: Partial<PaymentRecoveryDeps> = {}) {
  return new PaymentRecovery({ tasks: gw.tasks, payments: gw.payments, vault, now: later(60_000), ...over });
}
const settles = () => gw.fac.calls.filter((c) => c === 'settle').length;

describe('payment proof vault', () => {
  it('round-trips a verified payment and keeps the signature out of the stored text', async () => {
    gw = await makeGateway({ price: '0.05' });
    const v = await verified();
    const sealed = vault.seal(v);
    expect(sealed).not.toContain(v.paymentPayload.payload.signature);
    expect(sealed).not.toContain(v.payer);
    expect(vault.open(sealed)).toEqual(v);
    expect(() => new PaymentProofVault(Buffer.alloc(32, 1)).open(sealed)).toThrow();
  });
});

describe('payment lifecycle on the task row', () => {
  it('seals the proof while the job runs and clears it once the payment settled', async () => {
    gw = await makeGateway({ price: '0.05' });
    const req = decode((await gw.send()).headers['payment-required'] as string).accepts[0] as PaymentRequirements;
    const pending = gw.send({ headers: { 'PAYMENT-SIGNATURE': gw.payments.signX402(payerSeed, req).headers['PAYMENT-SIGNATURE'] as string } });
    const job = await gw.waitForJob();
    const during = gw.tasks.rows.get(job.payload.jobId);
    expect(during?.paymentProofEnc).toBeTruthy();
    expect(vault.open(during?.paymentProofEnc as string).amountMicroUsd).toBe(50_000n);

    await gw.post(`/n8n/v1/jobs/${job.payload.jobId}/complete`, { output: 'ok' });
    expect((await pending).status).toBe(200);
    expect(gw.tasks.rows.get(job.payload.jobId)).toMatchObject({ paymentTxn: '0xsettled', paymentProofEnc: null, paymentLeaseAt: null });
    expect(settles()).toBe(1);
  });

  it('clears the proof when the job fails', async () => {
    gw = await makeGateway({ price: '0.05' });
    const req = decode((await gw.send()).headers['payment-required'] as string).accepts[0] as PaymentRequirements;
    const pending = gw.send({ headers: { 'PAYMENT-SIGNATURE': gw.payments.signX402(payerSeed, req).headers['PAYMENT-SIGNATURE'] as string } });
    const job = await gw.waitForJob();
    await gw.post(`/n8n/v1/jobs/${job.payload.jobId}/complete`, { error: 'boom' });
    await pending;
    expect(gw.tasks.rows.get(job.payload.jobId)).toMatchObject({ status: 'FAILED', paymentProofEnc: null });
    expect(settles()).toBe(0);
  });

  it('does not leave a proof behind when settlement fails; the caller is told and nothing is retried later', async () => {
    gw = await makeGateway({ price: '0.05' });
    const req = decode((await gw.send()).headers['payment-required'] as string).accepts[0] as PaymentRequirements;
    gw.n8n.respond = (_j, r) => void r.writeHead(200, { 'Content-Type': 'application/json' }).end('{"output":"ok"}');
    gw.fac.settle = { success: false, errorReason: 'insufficient_funds' };
    const res = await gw.send({ headers: { 'PAYMENT-SIGNATURE': gw.payments.signX402(payerSeed, req).headers['PAYMENT-SIGNATURE'] as string } });
    expect(res.status).toBe(402);
    const [task] = [...gw.tasks.rows.values()];
    expect(task).toMatchObject({ status: 'COMPLETED', paymentProofEnc: null });
    gw.fac.settle = { success: true, transaction: '0xlate' };
    expect(await recovery().run()).toEqual({ settled: 0, released: 0, failed: 0 });
  });
});

describe('PaymentRecovery', () => {
  it('settles a COMPLETED task that a crash left unsettled, exactly once', async () => {
    gw = await makeGateway({ price: '0.05' });
    const id = await orphan('COMPLETED');
    expect(settles()).toBe(0);

    const r = recovery();
    expect(await r.run()).toEqual({ settled: 1, released: 0, failed: 0 });
    expect(gw.tasks.rows.get(id)).toMatchObject({ paymentTxn: '0xsettled', paymentProofEnc: null, paymentLeaseAt: null });
    expect(settles()).toBe(1);

    // another boot, or a second instance: nothing left to do
    expect(await r.run()).toEqual({ settled: 0, released: 0, failed: 0 });
    expect(await recovery().run()).toEqual({ settled: 0, released: 0, failed: 0 });
    expect(settles()).toBe(1);
  });

  it('settles once when two sweeps race', async () => {
    gw = await makeGateway({ price: '0.05' });
    await orphan('COMPLETED');
    const results = await Promise.all([recovery().run(), recovery().run(), recovery().run()]);
    expect(results.reduce((n, r) => n + r.settled, 0)).toBe(1);
    expect(settles()).toBe(1);
  });

  it('leaves a freshly completed task to its own request', async () => {
    gw = await makeGateway({ price: '0.05' });
    const id = await orphan('COMPLETED');
    expect(await recovery({ now: Date.now }).run()).toEqual({ settled: 0, released: 0, failed: 0 });
    expect(gw.tasks.rows.get(id)?.paymentProofEnc).toBeTruthy();
    expect(settles()).toBe(0);
  });

  it('releases proofs of failed and canceled tasks without settling', async () => {
    gw = await makeGateway({ price: '0.05' });
    const a = await orphan('FAILED');
    const b = await orphan('CANCELED');
    expect(await recovery().run()).toEqual({ settled: 0, released: 2, failed: 0 });
    expect(gw.tasks.rows.get(a)?.paymentProofEnc).toBeNull();
    expect(gw.tasks.rows.get(b)?.paymentProofEnc).toBeNull();
    expect(settles()).toBe(0);
  });

  it('times out an open task older than the task cap and releases it, but leaves a young one alone', async () => {
    gw = await makeGateway({ price: '0.05' });
    const id = await orphan('PROCESSING');
    expect(await recovery().run()).toEqual({ settled: 0, released: 0, failed: 0 }); // 1 minute old: its request may still be alive
    expect(gw.tasks.rows.get(id)?.status).toBe('PROCESSING');

    expect(await recovery({ now: later(10 * 60_000) }).run()).toEqual({ settled: 0, released: 1, failed: 0 });
    expect(gw.tasks.rows.get(id)).toMatchObject({ status: 'TIMEOUT', paymentProofEnc: null });
    expect(settles()).toBe(0);
  });

  it('settles a task that n8n completed after the Gateway restarted', async () => {
    gw = await makeGateway({ price: '0.05' });
    const id = await orphan('PROCESSING');
    await gw.post(`/n8n/v1/jobs/${id}/complete`, { output: 'late but done' });
    expect(gw.tasks.rows.get(id)?.status).toBe('COMPLETED');
    expect(await recovery().run()).toEqual({ settled: 1, released: 0, failed: 0 });
    expect(gw.tasks.rows.get(id)?.paymentTxn).toBe('0xsettled');
  });

  it('drops an authorization that expired before the sweep got to it', async () => {
    gw = await makeGateway({ price: '0.05' });
    const id = await orphan('COMPLETED');
    expect(await recovery({ now: later(2 * 3600_000) }).run()).toEqual({ settled: 0, released: 1, failed: 0 });
    expect(gw.tasks.rows.get(id)?.paymentProofEnc).toBeNull();
    expect(settles()).toBe(0);
  });

  it('retries after a transient facilitator error, and stops after a refusal', async () => {
    gw = await makeGateway({ price: '0.05' });
    const id = await orphan('COMPLETED');
    let down = true;
    const flaky = { ...gw.payments, settle: (v: VerifiedPayment) => (down ? Promise.reject(new ApiError('GATEWAY_UNAVAILABLE')) : gw.payments.settle(v)), release: gw.payments.release.bind(gw.payments) };
    const r = recovery({ payments: flaky });
    expect(await r.run()).toEqual({ settled: 0, released: 0, failed: 1 });
    expect(gw.tasks.rows.get(id)).toMatchObject({ paymentLeaseAt: null });
    expect(gw.tasks.rows.get(id)?.paymentProofEnc).toBeTruthy();
    down = false;
    expect(await r.run()).toEqual({ settled: 1, released: 0, failed: 0 });

    const refused = await orphan('COMPLETED');
    gw.fac.settle = { success: false, errorReason: 'nonce_used' };
    expect(await recovery().run()).toEqual({ settled: 0, released: 0, failed: 1 });
    expect(gw.tasks.rows.get(refused)?.paymentProofEnc).toBeNull();
    expect(await recovery().run()).toEqual({ settled: 0, released: 0, failed: 0 });
  });

  it('does not settle while another process holds the lease, and takes over once it is stale', async () => {
    gw = await makeGateway({ price: '0.05' });
    const id = await orphan('COMPLETED');
    expect(await gw.tasks.claimProof(id, 120_000)).toBeTruthy(); // another instance is mid-settle
    expect(await recovery({ now: later(60_000) }).run()).toEqual({ settled: 0, released: 0, failed: 0 });
    expect(settles()).toBe(0);
    expect(await recovery({ now: later(3 * 60_000), leaseMs: 120_000 }).run()).toEqual({ settled: 1, released: 0, failed: 0 });
  });
});

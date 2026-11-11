// Payment log lines: what `docker logs` shows when an x402 payment fails or looks odd.
// Each event is one `event key=value ...` line; no line may leak a signature, a key or the raw header.
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import { hex } from '../src/services/evm.js';
import { formatLine, reasonFromBody, usd } from '../src/services/paymentLog.js';
import { PaymentProcessor, type PaymentRequirements } from '../src/services/PaymentProcessor.js';
import { FakeRemoteAgent } from './helpers/fakeRemoteAgent.js';
import { API_KEY, captureLog, DEV, makeGateway, type Gateway } from './helpers/harness.js';

const x402 = loadConfig({}).x402;
const payerSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const payeeSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 100);
const decode = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

/** Everything that must never appear in a log line, for a payment signed by `seed`. */
function secretsOf(p: PaymentProcessor, seed: Uint8Array, header: string): string[] {
  const payload = decode(header) as { payload: { signature: string } };
  const sig = payload.payload.signature;
  const key = hex(p.deriveEvmKey(seed));
  return [header, payload.payload.signature, sig.replace(/^0x/, ''), key, key.replace(/^0x/, ''), hex(seed), hex(seed).replace(/^0x/, ''), API_KEY];
}
function expectNoSecrets(lines: string[], secrets: string[]): void {
  for (const line of lines) {
    expect(line, line).not.toMatch(/\n/);
    for (const s of secrets) expect(line.toLowerCase(), `line leaks ${s.slice(0, 12)}...`).not.toContain(s.toLowerCase());
  }
}

// --- the formatter -----------------------------------------------------------------------------

describe('formatLine / usd', () => {
  it('writes event then key=value, skipping unset values', () => {
    expect(formatLine('payment settled', { tx: '0xabc', payer: undefined, job: null, amountUsd: '0.05', ok: true, n: 3 })).toBe('payment settled tx=0xabc amountUsd=0.05 ok=true n=3');
  });
  it('keeps a line to one line: whitespace collapses, odd values are quoted, long ones cut', () => {
    const line = formatLine('e', { reason: 'bad\nthing  happened', eq: 'a=b', long: 'x'.repeat(500) });
    expect(line).not.toMatch(/\n/);
    expect(line).toContain('reason="bad thing happened"');
    expect(line).toContain('eq="a=b"');
    expect(line.length).toBeLessThan(500);
  });
  it('redacts signatures, long base64, bearer tokens and Gateway API keys, but keeps addresses and tx hashes', () => {
    const sig = '0x' + 'ab'.repeat(65);
    const blob = Buffer.from('x'.repeat(300)).toString('base64');
    const line = formatLine('e', { a: sig, b: blob, c: 'Bearer abc.def.ghi', d: 'zk_AbCdEf123456', addr: '0x' + 'c'.repeat(40), tx: '0x' + 'd'.repeat(64) });
    expect(line).not.toContain(sig);
    expect(line).not.toContain(blob.slice(0, 30));
    expect(line).not.toContain('abc.def.ghi');
    expect(line).not.toContain('zk_AbCdEf');
    expect(line).toContain('0x' + 'c'.repeat(40));
    expect(line).toContain('0x' + 'd'.repeat(64));
  });
  it('formats micro-USD with trimmed zeros and at least two decimals', () => {
    expect([50000n, 1_000_000n, 1n, 10_000n, 12_345_670n].map(usd)).toEqual(['0.05', '1.00', '0.000001', '0.01', '12.34567']);
  });
  it('finds the reason in the shapes remote servers use', () => {
    expect(reasonFromBody({ error: 'refused' })).toBe('refused');
    expect(reasonFromBody({ error: { message: 'Payment rejected', data: { details: { reason: 'insufficient_funds' } } } })).toBe('insufficient_funds');
    expect(reasonFromBody({ error: { message: 'nope' } })).toBe('nope');
    expect(reasonFromBody('x')).toBeUndefined();
  });
});

// --- PaymentProcessor --------------------------------------------------------------------------

function build(opts: { fac?: { verify?: unknown; settle?: unknown }; fetch?: typeof fetch; log?: Parameters<typeof makeLog>[0] } = {}) {
  const log = captureLog();
  const fac = { verify: { isValid: true } as unknown, settle: { success: true, transaction: '0xabc' } as unknown, ...opts.fac };
  const fetchImpl =
    opts.fetch ??
    ((async (url: string) => {
      const op = url.endsWith('/verify') ? 'verify' : 'settle';
      const r = fac[op];
      return typeof r === 'number' ? new Response('boom', { status: r }) : Response.json(r);
    }) as unknown as typeof fetch);
  const p = new PaymentProcessor({ config: x402, fetch: fetchImpl, log: opts.log ? makeLog(opts.log) : log });
  const payTo = p.evmAddress(payeeSeed);
  const req = p.requirementsFor(payTo, '0.05');
  const payer = p.evmAddress(payerSeed);
  return { p, log, fac, payTo, req, payer };
}
const makeLog = (kind: 'throws') => ({
  info: () => {
    if (kind === 'throws') throw new Error('log sink down');
  },
  warn: () => {
    throw new Error('log sink down');
  },
  error: () => {
    throw new Error('log sink down');
  },
});
const headerOf = (p: PaymentProcessor, req: PaymentRequirements) => p.signX402(payerSeed, req).headers['PAYMENT-SIGNATURE'] as string;

describe('PaymentProcessor log lines', () => {
  it('settle failure: logs the facilitator errorReason with payer, amount, job and listing', async () => {
    const { p, log, req, payer } = build({ fac: { settle: { success: false, errorReason: 'insufficient_funds' } } });
    const v = await p.verifyX402({ 'payment-signature': headerOf(p, req) }, req);
    const err = await p.settle(v, { jobId: 'job-1', listingId: 'lst-1' }).catch((e: unknown) => e as ApiError);
    // behaviour is unchanged
    expect(err).toMatchObject({ code: 'PAYMENT_FAILED', message: 'Payment settlement failed', details: { reason: 'insufficient_funds' } });
    const [hit, ...rest] = log.of('payment settle failed');
    expect(rest).toEqual([]);
    expect(hit?.level).toBe('error');
    expect(hit?.line).toBe(`payment settle failed reason=insufficient_funds payer=${payer} amountUsd=0.05 job=job-1 listing=lst-1 status=200 network=eip155:84532`);
  });

  it('settle success: logs the transaction hash at info', async () => {
    const { p, log, req, payer } = build({ fac: { settle: { success: true, transaction: '0x' + 'e'.repeat(64) } } });
    const v = await p.verifyX402({ 'payment-signature': headerOf(p, req) }, req);
    await p.settle(v, { jobId: 'job-2', listingId: 'lst-2' });
    expect(log.entries.filter((e) => e.level !== 'info')).toEqual([]);
    expect(log.of('payment settled')[0]?.line).toBe(`payment settled tx=0x${'e'.repeat(64)} payer=${payer} amountUsd=0.05 job=job-2 listing=lst-2 network=eip155:84532`);
  });

  it('settle failure without an errorReason still says so', async () => {
    const { p, log, req } = build({ fac: { settle: { success: false } } });
    const v = await p.verifyX402({ 'payment-signature': headerOf(p, req) }, req);
    await expect(p.settle(v)).rejects.toMatchObject({ code: 'PAYMENT_FAILED' });
    expect(log.of('payment settle failed')[0]?.line).toContain('reason=settle_failed');
  });

  it('verify rejected by the facilitator: logs its reason, payer, payTo, amount, network at warn', async () => {
    const { p, log, req, payer, payTo } = build({ fac: { verify: { isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_valid_after' } } });
    const err = await p.verifyX402({ 'payment-signature': headerOf(p, req) }, req, { listingId: 'lst-9' }).catch((e: unknown) => e as ApiError);
    expect(err).toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'invalid_exact_evm_payload_authorization_valid_after' } });
    const [hit] = log.of('payment verify rejected');
    expect(hit?.level).toBe('warn');
    expect(hit?.line).toMatch(new RegExp(`^payment verify rejected reason=invalid_exact_evm_payload_authorization_valid_after status=200 payer=${payer} payTo=${payTo} amountUsd=0.05 network=eip155:84532 nonce=0x[0-9a-f]{8} listing=lst-9$`));
  });

  it('verify rejected locally (expired) is logged with the same fields', async () => {
    const t = Date.now();
    const log = captureLog();
    const signer = new PaymentProcessor({ config: x402, now: () => t - 3_600_000 });
    const p = new PaymentProcessor({ config: x402, now: () => t, log, fetch: (async () => Response.json({ isValid: true })) as unknown as typeof fetch });
    const req = p.requirementsFor(p.evmAddress(payeeSeed), '0.05');
    const old = signer.signX402(payerSeed, { ...req, maxTimeoutSeconds: 60 }).headers['PAYMENT-SIGNATURE'] as string;
    await expect(p.verifyX402({ 'payment-signature': old }, req)).rejects.toMatchObject({ details: { reason: 'expired' } });
    expect(log.of('payment verify rejected')[0]?.line).toContain('reason=expired payer=');
  });

  it('an unpaid first request is the normal challenge and logs nothing', async () => {
    const { p, log, req } = build();
    await expect(p.verifyX402({}, req)).rejects.toMatchObject({ details: { reason: 'missing_payment' } });
    expect(log.entries).toEqual([]);
  });

  it('a replayed authorization is logged as replayed', async () => {
    const { p, log, req } = build();
    const h = headerOf(p, req);
    await p.verifyX402({ 'payment-signature': h }, req);
    await expect(p.verifyX402({ 'payment-signature': h }, req)).rejects.toMatchObject({ details: { reason: 'replayed' } });
    expect(log.of('payment verify rejected')[0]?.line).toContain('reason=replayed');
  });

  it('facilitator 5xx: logs an outage with op and status, error code unchanged', async () => {
    const { p, log, req, payer } = build({ fac: { settle: 503 } });
    const v = await p.verifyX402({ 'payment-signature': headerOf(p, req) }, req);
    await expect(p.settle(v, { jobId: 'j', listingId: 'l' })).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE', message: 'Payment facilitator error', details: { status: 503 } });
    const [hit] = log.of('payment facilitator unavailable');
    expect(hit?.level).toBe('error');
    expect(hit?.line).toBe(`payment facilitator unavailable op=settle status=503 payer=${payer} amountUsd=0.05 job=j listing=l`);
    expect(log.of('payment settle failed')).toEqual([]); // one line for the event, not two
  });

  it('facilitator unreachable: logs the network error message', async () => {
    const { p, log, req } = build({
      fetch: (async (url: string) => {
        if (url.endsWith('/verify')) return Response.json({ isValid: true });
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    const v = await p.verifyX402({ 'payment-signature': headerOf(p, req) }, req);
    await expect(p.settle(v)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE', message: 'Payment facilitator unreachable' });
    expect(log.of('payment facilitator unavailable')[0]?.line).toContain('op=settle reason="fetch failed"');
  });

  it('facilitator unreadable reply is logged', async () => {
    const { p, log, req } = build({ fetch: (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch });
    await expect(p.verifyX402({ 'payment-signature': headerOf(p, req) }, req)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
    expect(log.of('payment facilitator unavailable')[0]?.line).toContain('op=verify status=200 reason="unreadable response"');
  });

  it('never writes the signature, the raw header, the private key or the seed, even if the facilitator echoes them', async () => {
    const headers: string[] = [];
    const sign = (x: ReturnType<typeof build>): string => {
      const h = headerOf(x.p, x.req);
      headers.push(h);
      return h;
    };
    const sigOf = (h: string) => decode(h).payload.signature as string;

    // a happy path, plus two facilitators that repeat the proof back in their error text
    const ok = build();
    const h1 = sign(ok);
    await ok.p.settle(await ok.p.verifyX402({ 'payment-signature': h1 }, ok.req), { jobId: 'j', listingId: 'l' });

    const hostileVerify = build();
    const h2 = sign(hostileVerify);
    hostileVerify.fac.verify = { isValid: false, invalidReason: `bad proof ${sigOf(h2)}`, invalidMessage: `header was ${h2}\nline two` };
    await hostileVerify.p.verifyX402({ 'payment-signature': h2 }, hostileVerify.req).catch(() => undefined);

    const hostileSettle = build();
    const h3 = sign(hostileSettle);
    hostileSettle.fac.settle = { success: false, errorReason: sigOf(h3), errorMessage: h3 };
    const v3 = await hostileSettle.p.verifyX402({ 'payment-signature': h3 }, hostileSettle.req);
    await hostileSettle.p.settle(v3, { jobId: 'j', listingId: 'l' }).catch(() => undefined);

    const lines = [...ok.log.lines, ...hostileVerify.log.lines, ...hostileSettle.log.lines];
    expect(lines).toHaveLength(3); // settled, verify rejected, settle failed
    expectNoSecrets(lines, headers.flatMap((h) => secretsOf(ok.p, payerSeed, h)));
  });

  it('a logger that throws changes nothing', async () => {
    const { p, req } = build({ log: 'throws' });
    const v = await p.verifyX402({ 'payment-signature': headerOf(p, req) }, req);
    expect(await p.settle(v)).toMatchObject({ transaction: '0xabc' });
    await expect(p.verifyX402({}, req)).rejects.toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'missing_payment' } });
    const bad = build({ log: 'throws', fac: { settle: { success: false, errorReason: 'nope' } } });
    const v2 = await bad.p.verifyX402({ 'payment-signature': headerOf(bad.p, bad.req) }, bad.req);
    await expect(bad.p.settle(v2)).rejects.toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'nope' } });
  });
});

// --- inbound through the whole Gateway ---------------------------------------------------------

let gw: Gateway;
let remote: FakeRemoteAgent | undefined;
afterEach(async () => {
  await gw?.close();
  await remote?.close();
  remote = undefined;
});

const seed7 = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
async function challenge(): Promise<PaymentRequirements> {
  const res = await gw.send();
  expect(res.status).toBe(402);
  return decode(res.headers['payment-required'] as string).accepts[0];
}
const respondOk = (g: Gateway) => (g.n8n.respond = (_j, r) => void r.writeHead(200, { 'Content-Type': 'application/json' }).end('{"output":"ok"}'));

describe('inbound payment lines (A2AHandler)', () => {
  it('forced settle failure produces the diagnosable line, then the dropped proof, and the response is unchanged', async () => {
    const log = captureLog();
    gw = await makeGateway({ price: '0.05', log });
    const req = await challenge();
    respondOk(gw);
    gw.fac.settle = { success: false, errorReason: 'insufficient_funds' };
    const header = gw.payments.signX402(seed7, req).headers['PAYMENT-SIGNATURE'] as string;
    const res = await gw.send({ headers: { 'PAYMENT-SIGNATURE': header } });

    expect(res.status).toBe(402);
    expect(res.body.error.data).toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'insufficient_funds' } });
    const [task] = [...gw.tasks.rows.values()];
    const payer = gw.payments.evmAddress(seed7);
    const [failed] = log.of('payment settle failed');
    expect(failed?.level).toBe('error');
    expect(failed?.line).toMatch(new RegExp(`^payment settle failed reason=insufficient_funds payer=${payer} amountUsd=0.05 job=${task?.id} listing=${gw.listing.id} `));
    const [dropped] = log.of('payment proof dropped');
    expect(dropped?.level).toBe('warn');
    expect(dropped?.line).toBe(`payment proof dropped reason=settle_failed cause=PAYMENT_FAILED payer=${payer} amountUsd=0.05 job=${task?.id} listing=${gw.listing.id}`);
    expectNoSecrets(log.lines, secretsOf(gw.payments, seed7, header));
  });

  it('settle success logs the transaction hash with job and listing', async () => {
    const log = captureLog();
    gw = await makeGateway({ price: '0.05', log });
    const req = await challenge();
    respondOk(gw);
    const header = gw.payments.signX402(seed7, req).headers['PAYMENT-SIGNATURE'] as string;
    const res = await gw.send({ headers: { 'PAYMENT-SIGNATURE': header } });
    expect(res.status).toBe(200);
    const [task] = [...gw.tasks.rows.values()];
    expect(log.entries.map((e) => e.level)).toEqual(['info']); // the challenge, the verify and the 200 add nothing else
    expect(log.lines[0]).toBe(`payment settled tx=0xsettled payer=${gw.payments.evmAddress(seed7)} amountUsd=0.05 job=${task?.id} listing=${gw.listing.id} network=eip155:84532`);
    expectNoSecrets(log.lines, secretsOf(gw.payments, seed7, header));
  });

  it('a verify rejection is logged with the listing, and the unpaid challenge is not', async () => {
    const log = captureLog();
    gw = await makeGateway({ price: '0.05', log });
    const req = await challenge();
    expect(log.entries).toEqual([]);
    gw.fac.verify = { isValid: false, invalidReason: 'insufficient_funds' };
    const header = gw.payments.signX402(seed7, req).headers['PAYMENT-SIGNATURE'] as string;
    const res = await gw.send({ headers: { 'PAYMENT-SIGNATURE': header } });
    expect(res.status).toBe(402);
    expect(log.entries).toHaveLength(1);
    expect(log.lines[0]).toContain(`payment verify rejected reason=insufficient_funds status=200 payer=${gw.payments.evmAddress(seed7)} payTo=${req.payTo} amountUsd=0.05 network=eip155:84532`);
    expect(log.lines[0]).toMatch(new RegExp(`listing=${gw.listing.id}$`));
    expectNoSecrets(log.lines, secretsOf(gw.payments, seed7, header));
  });

  it('a job that fails releases the proof and says nobody was charged', async () => {
    const log = captureLog();
    gw = await makeGateway({ price: '0.05', log });
    const req = await challenge();
    const pending = gw.send({ headers: { 'PAYMENT-SIGNATURE': gw.payments.signX402(seed7, req).headers['PAYMENT-SIGNATURE'] as string } });
    const job = await gw.waitForJob();
    await gw.post(`/n8n/v1/jobs/${job.payload.jobId}/complete`, { error: 'boom' });
    await pending;
    const [dropped] = log.of('payment proof dropped');
    expect(dropped?.level).toBe('info');
    expect(dropped?.line).toContain(`reason=job_failed payer=${gw.payments.evmAddress(seed7)} amountUsd=0.05 job=${job.payload.jobId} listing=${gw.listing.id}`);
    expect(log.of('payment settle')).toEqual([]);
  });

  it('a workflow that cannot be reached releases the proof', async () => {
    const log = captureLog();
    gw = await makeGateway({ price: '0.05', log });
    const req = await challenge();
    gw.n8n.respond = (_j, r) => void r.writeHead(500).end('x');
    const res = await gw.send({ headers: { 'PAYMENT-SIGNATURE': gw.payments.signX402(seed7, req).headers['PAYMENT-SIGNATURE'] as string } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(log.of('payment proof dropped')[0]?.line).toContain('reason=workflow_unreachable');
  });
});

// --- outbound ----------------------------------------------------------------------------------

const REMOTE_ID = 'zns:remote0000000000000000000000001';
async function outbound(remoteOpts: ConstructorParameters<typeof FakeRemoteAgent>[0], keyFields: Parameters<Gateway['apiKeys']['add']>[1] = { developerId: DEV }) {
  const log = captureLog();
  gw = await makeGateway({ log });
  remote = new FakeRemoteAgent(remoteOpts);
  await remote.listen();
  gw.dns.entities.set(REMOTE_ID, { entity_id: REMOTE_ID, public_key: '', entity_url: remote.url, name: 'Remote', category: 'x', tags: [], summary: 's', developer_id: 'd' });
  const key = gw.apiKeys.add('zk_outbound_key_0001', keyFields);
  const call = (body: unknown) => gw.post(`/n8n/v1/agents/${encodeURIComponent(REMOTE_ID)}/tasks`, body, 'zk_outbound_key_0001');
  return { log, call, key };
}
const devAddress = (g: Gateway) => g.payments.evmAddress(Uint8Array.from({ length: 32 }, (_, i) => i + 1));

describe('outbound payment lines (AgentCaller)', () => {
  it('paid call: logs target, amount, tx, payer and which wallet paid', async () => {
    const { log, call } = await outbound({ priceUsd: '0.05' });
    const res = await call({ input: { q: 1 } });
    expect(res.status).toBe(200);
    expect(log.entries.map((e) => e.level)).toEqual(['info']);
    expect(log.lines[0]).toBe(`payment paid amountUsd=0.05 tx=0xremote payer=${devAddress(gw)} target=agent:${REMOTE_ID} wallet=developer task=${res.body.taskId}`);
    expectNoSecrets(log.lines, [hex(gw.payments.deriveEvmKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1))), 'zk_outbound_key_0001']);
  });

  it('payFromListingId: names the listing wallet', async () => {
    const { log, call } = await outbound({ priceUsd: '0.05' });
    const res = await call({ input: 1, payFromListingId: gw.listing.id });
    expect(res.status).toBe(200);
    expect(log.lines[0]).toContain(`wallet=listing:${gw.listing.id} listing=${gw.listing.id}`);
    expect(log.lines[0]).not.toContain(devAddress(gw));
  });

  it('a price above maxPaymentUsd is logged with required vs ceiling', async () => {
    const { log, call } = await outbound({ priceUsd: '0.05' });
    const res = await call({ input: 1, maxPaymentUsd: '0.01' });
    expect(res.body.code).toBe('PAYMENT_CAP'); // unchanged
    const [hit] = log.of('payment cap refused');
    expect(hit?.level).toBe('warn');
    expect(hit?.line).toBe(`payment cap refused cap=maxPaymentUsd requiredUsd=0.05 maxPaymentUsd=0.01 target=agent:${REMOTE_ID} wallet=developer task=${[...gw.tasks.rows.keys()][0]}`);
  });

  it('the API key spend cap is logged with the key id, not the key', async () => {
    const { log, call, key } = await outbound({ priceUsd: '0.05' }, { developerId: DEV, spendCapUsd: '0.08', spentUsd: '0.050000' });
    const res = await call({ input: 1 });
    expect(res.body).toMatchObject({ code: 'PAYMENT_CAP', details: { requiredUsd: '0.050000' } });
    expect(log.of('payment cap refused')[0]?.line).toContain(`cap=keySpend requiredUsd=0.05 key=${key.id}`);
    expectNoSecrets(log.lines, ['zk_outbound_key_0001']);
  });

  it('an agent that rejects the payment: logs the reason from its reply body', async () => {
    const { log, call } = await outbound({ priceUsd: '0.05', paidStatus: 402 });
    const res = await call({ input: 1 });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: 'PAYMENT_FAILED', error: 'Agent rejected the payment' }); // unchanged
    const [hit] = log.of('payment rejected by agent');
    expect(hit?.level).toBe('warn');
    expect(hit?.line).toBe(`payment rejected by agent reason=refused status=402 amountUsd=0.05 payer=${devAddress(gw)} target=agent:${REMOTE_ID} wallet=developer task=${res.body.taskId ?? [...gw.tasks.rows.keys()][0]}`);
    expect(log.of('payment paid')).toEqual([]);
  });

  it('an agent that fails the paid call with another status: logged as not taken', async () => {
    const { log, call } = await outbound({ priceUsd: '0.05', paidStatus: 500 });
    await call({ input: 1 });
    expect(log.of('payment not taken by agent')[0]?.line).toContain('reason=refused status=500');
  });

  it('a free call logs nothing', async () => {
    const { log, call } = await outbound({});
    expect((await call({ input: 1 })).status).toBe(200);
    expect(log.entries).toEqual([]);
  });
});

// Outbound paid calls (HLD flow 2): M2.13-M2.16.
import { afterEach, describe, expect, it } from 'vitest';
import { API_KEY, DEV, makeGateway, type Gateway } from './helpers/harness.js';
import { FakeRemoteAgent } from './helpers/fakeRemoteAgent.js';

let gw: Gateway;
let remote: FakeRemoteAgent;
afterEach(async () => {
  await gw?.close();
  await remote?.close();
});

const REMOTE_ID = 'zns:remote0000000000000000000000001';

async function setup(opts: ConstructorParameters<typeof FakeRemoteAgent>[0] = {}, keyFields: Parameters<Gateway['apiKeys']['add']>[1] = { developerId: DEV }, callerTimeoutMs?: number) {
  gw = await makeGateway({ callerTimeoutMs });
  remote = new FakeRemoteAgent(opts);
  await remote.listen();
  gw.dns.entities.set(REMOTE_ID, { entity_id: REMOTE_ID, public_key: '', entity_url: remote.url, name: 'Remote', category: 'x', tags: [], summary: 's', developer_id: 'd' });
  const key = gw.apiKeys.add('zk_outbound_key_0001', keyFields);
  const call = (body: unknown, k = 'zk_outbound_key_0001') => gw.post(`/n8n/v1/agents/${encodeURIComponent(REMOTE_ID)}/tasks`, body, k);
  return { key, call };
}

describe('free call (M2.14)', () => {
  it('signs as the developer, calls the agent and returns its result', async () => {
    const { call } = await setup();
    const res = await call({ input: { q: 'meaning of life' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'COMPLETED', output: { answer: 42 }, error: null, paymentUsd: null, paymentTxn: null });
    // the remote verified x-zynd-auth (nonce store, signature, entity id) and saw our payload
    expect(remote.requests[0]).toMatchObject({ method: 'message/send', auth: true, paid: false });
    expect(remote.receivedMessages[0]?.parts).toEqual([{ kind: 'data', data: { q: 'meaning of life' } }]);
    // stored as an OUTBOUND task owned by the key
    const row = gw.tasks.rows.get(res.body.taskId)!;
    expect(row).toMatchObject({ direction: 'OUTBOUND', status: 'COMPLETED', developerId: DEV, listingId: null });
    expect(row.apiKeyId).toBe(gw.apiKeys.rows.get(row.apiKeyId as string)?.id);
  });

  it('sends a string as a text part', async () => {
    const { call } = await setup({ mode: 'message' });
    const res = await call({ input: 'ping' });
    expect(remote.receivedMessages[0]?.parts).toEqual([{ kind: 'text', text: 'ping' }]);
    expect(res.body).toMatchObject({ status: 'COMPLETED', output: 'pong' }); // a direct Message reply is a final answer
  });

  it('polls tasks/get until the remote task finishes', async () => {
    const { call } = await setup({ mode: 'task-working-then-done' });
    const res = await call({ input: {} });
    expect(res.body).toMatchObject({ status: 'COMPLETED', output: { answer: 42 } });
    expect(remote.polls).toBeGreaterThanOrEqual(2);
  });

  it('reports a failed remote task as FAILED with its message (200: the call ran)', async () => {
    const { call } = await setup({ mode: 'task-failed' });
    const res = await call({ input: {} });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'FAILED', error: 'remote exploded', output: null });
  });

  it('maps a remote JSON-RPC error to 502 and a FAILED task', async () => {
    const { call } = await setup({ mode: 'rpc-error' });
    const res = await call({ input: {} });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/bad input/);
    expect([...gw.tasks.rows.values()][0]).toMatchObject({ status: 'FAILED' });
  });

  it('times out a task that never finishes (504, TIMEOUT)', async () => {
    const { call } = await setup({ mode: 'never-finishes' }, { developerId: DEV }, 400);
    const t0 = Date.now();
    const res = await call({ input: {} });
    expect(res.status).toBe(504);
    expect(res.body.code).toBe('TASK_TIMEOUT');
    expect([...gw.tasks.rows.values()][0]).toMatchObject({ status: 'TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('404s an unknown agent and validates input', async () => {
    const { call } = await setup();
    expect((await gw.post('/n8n/v1/agents/zns:ghost/tasks', { input: 1 }, 'zk_outbound_key_0001')).status).toBe(404);
    expect((await call({})).status).toBe(400);
    expect((await call({ input: 1, maxPaymentUsd: '-5' })).status).toBe(400);
  });

  it('needs the "call" permission', async () => {
    await setup();
    gw.apiKeys.add('zk_no_call_key_000001', { developerId: DEV, permissions: ['search'] });
    const res = await gw.post(`/n8n/v1/agents/${encodeURIComponent(REMOTE_ID)}/tasks`, { input: 1 }, 'zk_no_call_key_000001');
    expect(res.status).toBe(403);
  });
});

describe('paid call (M2.14, M2.16)', () => {
  it('answers the 402 challenge with a payment the remote accepts, and records the spend', async () => {
    const { call, key } = await setup({ priceUsd: '0.05' });
    const res = await call({ input: { q: 1 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'COMPLETED', output: { answer: 42 }, paymentUsd: '0.050000', paymentTxn: '0xremote' });
    // two attempts: unpaid, then paid with a *fresh* x-zynd-auth nonce (the remote claims nonces, so a reuse would 401)
    expect(remote.requests.map((r) => [r.auth, r.paid])).toEqual([[true, false], [true, true]]);
    // the payer is the developer's derived EVM address, never exposed to n8n
    expect(remote.payers).toEqual([gw.payments.evmAddress(Uint8Array.from({ length: 32 }, (_, i) => i + 1))]);
    expect(gw.apiKeys.spent(key.id)).toBe(50000n);
    expect(gw.tasks.rows.get(res.body.taskId)).toMatchObject({ paymentUsd: '0.050000', paymentTxn: '0xremote' });
  });

  it('refuses a price above maxPaymentUsd before signing anything', async () => {
    const { call, key } = await setup({ priceUsd: '0.05' });
    const res = await call({ input: 1, maxPaymentUsd: '0.01' });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('PAYMENT_CAP');
    expect(remote.requests).toHaveLength(1); // only the unpaid attempt
    expect(gw.apiKeys.spent(key.id)).toBe(0n);
  });

  it('applies the default ceiling (0.10) when maxPaymentUsd is omitted', async () => {
    const { call } = await setup({ priceUsd: '0.50' });
    expect((await call({ input: 1 })).body.code).toBe('PAYMENT_CAP');
  });

  it('refuses when the call would exceed the key\'s spend cap (PAYMENT_CAP)', async () => {
    const { call, key } = await setup({ priceUsd: '0.05' }, { developerId: DEV, spendCapUsd: '0.08', spentUsd: '0.050000' });
    const res = await call({ input: 1 });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: 'PAYMENT_CAP', details: { requiredUsd: '0.050000' } });
    expect(gw.apiKeys.spent(key.id)).toBe(50000n); // unchanged
    expect(remote.payers).toEqual([]);
  });

  it('never overshoots the cap under concurrent calls (M2.16)', async () => {
    const { call, key } = await setup({ priceUsd: '0.05' }, { developerId: DEV, spendCapUsd: '0.20' });
    const results = await Promise.all(Array.from({ length: 12 }, () => call({ input: 1 })));
    const ok = results.filter((r) => r.status === 200).length;
    const capped = results.filter((r) => r.body.code === 'PAYMENT_CAP').length;
    expect(ok).toBe(4); // 4 x 0.05 = 0.20
    expect(capped).toBe(8);
    expect(gw.apiKeys.spent(key.id)).toBe(200_000n);
    expect(remote.payers).toHaveLength(4);
  });

  it('gives the reservation back when the agent refuses the paid request without settling', async () => {
    const { call, key } = await setup({ priceUsd: '0.05', paidStatus: 500 });
    const res = await call({ input: 1 });
    expect(res.status).toBe(502);
    expect(gw.apiKeys.spent(key.id)).toBe(0n);
    expect([...gw.tasks.rows.values()][0]).toMatchObject({ status: 'FAILED' });
  });

  it('does not cap-check or pay a free agent', async () => {
    const { call, key } = await setup({}, { developerId: DEV, spendCapUsd: '0' });
    expect((await call({ input: 1 })).status).toBe(200);
    expect(gw.apiKeys.spent(key.id)).toBe(0n);
  });
});

describe('GET /n8n/v1/tasks/:id (M2.15)', () => {
  it('returns status and output to the key that made the call, and to no one else', async () => {
    const { call } = await setup();
    const made = await call({ input: 1 });
    const got = await gw.get(`/n8n/v1/tasks/${made.body.taskId}`, 'zk_outbound_key_0001');
    expect(got.status).toBe(200);
    expect(got.body).toEqual(made.body);
    // same developer, different key: not visible
    expect((await gw.get(`/n8n/v1/tasks/${made.body.taskId}`)).status).toBe(404);
    expect((await gw.get(`/n8n/v1/tasks/nope`, 'zk_outbound_key_0001')).status).toBe(404);
    expect(API_KEY).toBeTruthy();
  });
});

describe('payFromListingId (Zynd x AirnodeHub showcase: an agent pays from its own wallet)', () => {
  it('signs the payment with the listing wallet while x-zynd-auth stays the developer', async () => {
    const { call } = await setup({ priceUsd: '0.05' });
    const res = await call({ input: {}, maxPaymentUsd: '0.10', payFromListingId: gw.listing.id });
    expect(res.status).toBe(200);
    const row = gw.store.listings.get(gw.listing.id)!;
    const agent = await gw.identity.getListingKeypair({ listingId: row.id, developerId: DEV, derivedKeyIndex: row.derivedKeyIndex });
    expect(remote.payers.at(-1)).toBe(gw.payments.evmAddress(agent.privateKey));
    expect(remote.requests.at(-1)).toMatchObject({ auth: true, paid: true });
  });

  it('refuses a listing that is not the caller’s, before calling anyone', async () => {
    const { call } = await setup({ priceUsd: '0.05' });
    const res = await call({ input: {}, payFromListingId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(404);
    expect(remote.requests).toHaveLength(0);
  });
});

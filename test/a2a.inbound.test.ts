// Inbound paid calls (HLD flow 4): M2.6-M2.12 end to end over real HTTP.
import { afterEach, describe, expect, it } from 'vitest';
import { API_KEY, WEBHOOK_SECRET, makeGateway, type Gateway } from './helpers/harness.js';

let gw: Gateway;
afterEach(async () => {
  await gw?.close();
});

const artifactData = (res: { body: { result: { artifacts?: { parts: { data?: unknown; text?: string }[] }[] } } }) => res.body.result.artifacts?.[0]?.parts[0];

describe('tasks/send, free listing (M2.9, M2.11)', () => {
  it('forwards to n8n, waits for jobs/complete and answers with the output (flow 4)', async () => {
    gw = await makeGateway();
    const pending = gw.send({ data: { city: 'Pune' } });
    const job = await gw.waitForJob();

    // what n8n received
    expect(job.headers['x-zynd-webhook-secret']).toBe(WEBHOOK_SECRET);
    expect(job.payload).toMatchObject({ listingId: gw.listing.id, entityId: gw.entityId, input: { city: 'Pune' } });
    expect(JSON.stringify(job.payload.message)).not.toContain('x-zynd-auth'); // caller's signature is not forwarded

    const done = await gw.post(`/n8n/v1/jobs/${job.payload.jobId}/complete`, { output: { temp: 31 } });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ jobId: job.payload.jobId, status: 'COMPLETED' });

    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 1, result: { kind: 'task', id: job.payload.jobId, status: { state: 'completed' } } });
    expect(artifactData(res)).toEqual({ kind: 'data', data: { temp: 31 } });

    const row = gw.tasks.rows.get(job.payload.jobId);
    expect(row).toMatchObject({ direction: 'INBOUND', status: 'COMPLETED', callerId: expect.stringMatching(/^zns:/), listingId: gw.listing.id });
  });

  it('answers within a few ms of completion, not on the next 2 s poll tick (G2)', async () => {
    gw = await makeGateway({ pollIntervalMs: 2000 });
    const pending = gw.send();
    const job = await gw.waitForJob();
    const t0 = Date.now();
    await gw.post(`/n8n/v1/jobs/${job.payload.jobId}/complete`, { output: 'hi' });
    const res = await pending;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(artifactData(res)).toEqual({ kind: 'text', text: 'hi' });
  });

  it('finishes at once when the webhook answers with an output (responseMode = lastNode, G2)', async () => {
    gw = await makeGateway();
    gw.n8n.respond = (_j, res) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ output: { sync: true } }));
    const res = await gw.send();
    expect(res.status).toBe(200);
    expect(artifactData(res)).toEqual({ kind: 'data', data: { sync: true } });
  });

  it('returns a failed task (not a transport error) when the workflow reports an error', async () => {
    gw = await makeGateway();
    const pending = gw.send();
    const job = await gw.waitForJob();
    const done = await gw.post(`/n8n/v1/jobs/${job.payload.jobId}/complete`, { error: 'city not found' });
    expect(done.body.status).toBe('FAILED');
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.result.status.state).toBe('failed');
    expect(res.body.result.status.message.parts[0].text).toBe('city not found');
  });

  it('accepts message/send as an alias (what the SDK client calls)', async () => {
    gw = await makeGateway();
    gw.n8n.respond = (_j, res) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"output":1}');
    expect((await gw.send({ method: 'message/send' })).body.result.status.state).toBe('completed');
  });

  it('fails the task and answers 502 when the webhook is down', async () => {
    gw = await makeGateway();
    gw.n8n.respond = (_j, res) => void res.writeHead(500).end();
    const res = await gw.send();
    expect(res.status).toBe(502);
    expect(res.body.error.data.code).toBe('GATEWAY_UNAVAILABLE');
    expect([...gw.tasks.rows.values()][0]).toMatchObject({ status: 'FAILED' });
  });
});

describe('auth on the A2A endpoint (M2.6)', () => {
  it('rejects an unsigned message with a JSON-RPC auth error and never reaches n8n', async () => {
    gw = await makeGateway();
    const res = await gw.send({ signed: false });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32100, data: { code: 'AUTH_INVALID' } } });
    expect(gw.jobs).toHaveLength(0);
  });

  it('rejects a replayed request (-32101)', async () => {
    gw = await makeGateway();
    gw.n8n.respond = (_j, res) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"output":1}');
    const m = gw.message();
    const { signZyndAuth } = await import('../src/services/zyndAuth.js');
    signZyndAuth(m, gw.callerKey);
    const url = `/a/${encodeURIComponent(gw.entityId)}/a2a/v1`;
    const { default: request } = await import('supertest');
    const first = await request(gw.app).post(url).send(gw.rpc('tasks/send', { message: m }));
    const second = await request(gw.app).post(url).send(gw.rpc('tasks/send', { message: m }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe(-32101);
    expect(gw.jobs).toHaveLength(1);
  });
});

describe('listing state (M2.12)', () => {
  it('rejects a deactivated listing with LISTING_INACTIVE (409)', async () => {
    gw = await makeGateway();
    await gw.listings.deactivate('zns:dev:harness', gw.listing.id);
    const res = await gw.send();
    expect(res.status).toBe(409);
    expect(res.body.error.data.code).toBe('LISTING_INACTIVE');
    expect(gw.jobs).toHaveLength(0);
  });

  it('rejects a listing whose webhook was removed', async () => {
    gw = await makeGateway();
    await gw.del(`/n8n/v1/webhooks/${gw.listing.id}`);
    const res = await gw.send();
    expect(res.status).toBe(409);
    expect(res.body.error.data.code).toBe('LISTING_INACTIVE');
  });

  it('404s an unknown agent', async () => {
    gw = await makeGateway();
    const { default: request } = await import('supertest');
    const { signZyndAuth } = await import('../src/services/zyndAuth.js');
    const m = signZyndAuth(gw.message(), gw.callerKey);
    const res = await request(gw.app).post('/a/zns:nope/a2a/v1').send(gw.rpc('tasks/send', { message: m }));
    expect(res.status).toBe(404);
  });
});

describe('timeout (M2.12)', () => {
  it('marks the task TIMEOUT and answers TASK_TIMEOUT (504); a late completion is refused', async () => {
    gw = await makeGateway({ timeoutMs: 150, pollIntervalMs: 20 });
    const res = await gw.send();
    expect(res.status).toBe(504);
    expect(res.body.error.data.code).toBe('TASK_TIMEOUT');
    const job = await gw.waitForJob();
    expect(gw.tasks.rows.get(job.payload.jobId)?.status).toBe('TIMEOUT');
    const late = await gw.post(`/n8n/v1/jobs/${job.payload.jobId}/complete`, { output: 'too late' });
    expect(late.status).toBe(409);
    expect(gw.tasks.rows.get(job.payload.jobId)?.output).toBeNull();
  });
});

describe('tasks/get and tasks/cancel (M2.10, G6)', () => {
  const call = (id: string, method: string, taskId: string, entity?: string) =>
    import('supertest').then(({ default: request }) =>
      request(gw.app).post(`/a/${encodeURIComponent(entity ?? gw.entityId)}/a2a/v1`).send(gw.rpc(method, { id: taskId }, id)),
    );

  it('reports the state of an open and a finished task', async () => {
    gw = await makeGateway();
    const pending = gw.send();
    const job = await gw.waitForJob();
    const id = job.payload.jobId;
    expect((await call('g1', 'tasks/get', id)).body).toMatchObject({ jsonrpc: '2.0', id: 'g1', result: { id, status: { state: 'working' } } });
    await gw.post(`/n8n/v1/jobs/${id}/complete`, { output: { n: 1 } });
    await pending;
    const got = await call('g2', 'tasks/get', id);
    expect(got.body.result.status.state).toBe('completed');
    expect(got.body.result.artifacts[0].parts[0]).toEqual({ kind: 'data', data: { n: 1 } });
  });

  it('cancels an open task: the waiting send returns canceled and a late completion is refused', async () => {
    gw = await makeGateway();
    const pending = gw.send();
    const job = await gw.waitForJob();
    const id = job.payload.jobId;
    const canceled = await call('c1', 'tasks/cancel', id);
    expect(canceled.status).toBe(200);
    expect(canceled.body.result.status.state).toBe('canceled');
    const res = await pending;
    expect(res.body.result.status.state).toBe('canceled');
    expect((await gw.post(`/n8n/v1/jobs/${id}/complete`, { output: 1 })).status).toBe(409);
  });

  it('reports not-cancelable (-32002) for a finished task and not-found (-32001) for strangers', async () => {
    gw = await makeGateway();
    gw.n8n.respond = (_j, res) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"output":1}');
    const sent = await gw.send();
    const id = sent.body.result.id as string;
    const again = await call('c2', 'tasks/cancel', id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe(-32002);
    const unknown = await call('c3', 'tasks/get', 'no-such-task');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe(-32001);
    // a real task id presented to a different agent is "not found" too
    const other = await call('c4', 'tasks/get', id, 'zns:someoneelse');
    expect(other.body.error.code).toBe(-32001);
  });

  it('speaks JSON-RPC: bad envelope, unknown method, missing params', async () => {
    gw = await makeGateway();
    const { default: request } = await import('supertest');
    const url = `/a/${encodeURIComponent(gw.entityId)}/a2a/v1`;
    expect((await request(gw.app).post(url).send({ nope: true })).body.error.code).toBe(-32602);
    const nm = await request(gw.app).post(url).send(gw.rpc('tasks/dance', {}));
    expect(nm.body.error.code).toBe(-32601);
    const np = await request(gw.app).post(url).send(gw.rpc('tasks/get', {}));
    expect(np.body.error.code).toBe(-32602);
    const nomsg = await request(gw.app).post(url).send(gw.rpc('tasks/send', { message: 'x' }));
    expect(nomsg.body.error.code).toBe(-32602);
  });
});

describe('POST /n8n/v1/jobs/:id/complete (M2.11)', () => {
  it('is scoped to the key\'s developer, validates the body and is not repeatable', async () => {
    gw = await makeGateway();
    const pending = gw.send();
    const job = await gw.waitForJob();
    const id = job.payload.jobId;

    const stranger = gw.apiKeys.add('zk_other_developer_key', { developerId: 'zns:dev:other' });
    expect(stranger.developerId).toBe('zns:dev:other');
    expect((await gw.post(`/n8n/v1/jobs/${id}/complete`, { output: 1 }, 'zk_other_developer_key')).status).toBe(404);
    expect((await gw.post(`/n8n/v1/jobs/${id}/complete`, {})).status).toBe(400);
    expect((await gw.post(`/n8n/v1/jobs/nope/complete`, { output: 1 })).status).toBe(404);

    expect((await gw.post(`/n8n/v1/jobs/${id}/complete`, { output: null })).status).toBe(200);
    await pending;
    const twice = await gw.post(`/n8n/v1/jobs/${id}/complete`, { output: 2 });
    expect(twice.status).toBe(409);
    expect(API_KEY).toBeTruthy();
  });

  it('needs the "complete" permission', async () => {
    gw = await makeGateway();
    gw.apiKeys.add('zk_search_only_key_01', { developerId: 'zns:dev:harness', permissions: ['search'] });
    const res = await gw.post('/n8n/v1/jobs/x/complete', { output: 1 }, 'zk_search_only_key_01');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTH_FORBIDDEN');
  });
});

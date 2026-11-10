// M3.12: the paid round trip with the REAL compiled n8n-nodes-zynd package (../n8n-nodes-zynd/dist)
// on one side and the real Gateway on the other. Only the n8n runtime is faked: a small context
// that sends each node request to the Gateway app, applying the credential's own `authenticate`
// header template. Skipped when the sibling package has not been built (`npm run build` there).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaymentRequirements } from '../src/services/PaymentProcessor.js';
import { FakeRemoteAgent } from './helpers/fakeRemoteAgent.js';
import { API_KEY, DEV, WEBHOOK_SECRET, makeGateway, type Gateway, type Job } from './helpers/harness.js';

const dist = resolve(__dirname, '../../n8n-nodes-zynd/dist');
const built = existsSync(`${dist}/nodes/Zynd/Zynd.node.js`);
const load = (p: string) => createRequire(import.meta.url)(`${dist}/${p}`);

interface Req { method: string; url: string; qs?: Record<string, unknown>; body?: unknown }

describe.skipIf(!built)('n8n-nodes-zynd against the Gateway (M3.12)', () => {
  const { Zynd } = built ? load('nodes/Zynd/Zynd.node.js') : ({} as never);
  const { ZyndTrigger } = built ? load('nodes/Zynd/ZyndTrigger.node.js') : ({} as never);
  const { ZyndApi } = built ? load('credentials/ZyndApi.credentials.js') : ({} as never);

  let gw: Gateway;
  let remote: FakeRemoteAgent | undefined;
  afterEach(async () => {
    await gw?.close();
    await remote?.close();
    remote = undefined;
  });

  /** An n8n context whose HTTP helper talks to the Gateway app and signs requests like the credential would. */
  function ctx(params: Record<string, unknown>, opts: { apiKey?: string; webhookSecret?: string; webhookUrl?: string; headers?: Record<string, unknown>; body?: Record<string, unknown>; items?: unknown[] } = {}) {
    const cred = { apiUrl: 'https://gw.test', apiKey: opts.apiKey ?? API_KEY, webhookSecret: opts.webhookSecret ?? 'e2e-webhook-secret' };
    const template: string = new ZyndApi().authenticate.properties.headers['X-Zynd-Api-Key'];
    const state = { status: undefined as number | undefined, requests: [] as Req[] };
    const self = {
      state,
      getNode: () => ({ name: 'Zynd', type: 'n8n-nodes-zynd.zynd', typeVersion: 1, position: [0, 0], parameters: {}, id: 'x' }),
      getCredentials: async () => cred,
      getInputData: () => (opts.items ?? [{}]).map((json) => ({ json })),
      getNodeParameter: (name: string, ...r: unknown[]) => (name in params ? params[name] : r[1]),
      continueOnFail: () => false,
      getNodeWebhookUrl: () => opts.webhookUrl ?? gw.webhookUrl,
      getHeaderData: () => opts.headers ?? {},
      getBodyData: () => opts.body ?? {},
      getResponseObject: () => {
        const res = { status: (c: number) => ((state.status = c), res), end: () => res };
        return res;
      },
      helpers: {
        httpRequestWithAuthentication: async (_name: string, o: Req & { url: string }) => {
          const path = o.url.replace('https://gw.test', '');
          state.requests.push({ method: o.method, url: path, qs: o.qs, body: o.body });
          const r = request(gw.app)[o.method.toLowerCase() as 'get'](path).set('X-Zynd-Api-Key', template.replace('={{$credentials.apiKey}}', cred.apiKey));
          const res = await (o.qs ? r.query(o.qs as object) : r).send(o.body as object);
          return { statusCode: res.status, body: res.body };
        },
      },
    };
    return self;
  }

  const decode = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const payerSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
  const hooks = () => new ZyndTrigger().webhookMethods.default;

  /** Plays n8n: runs the trigger with the job, then the workflow `then` on whatever the trigger emitted. */
  function playN8n(webhookSecret: string, then: (jobJson: Record<string, unknown>, res: ServerResponse) => void) {
    gw.n8n.respond = (job: Job, res: ServerResponse) => {
      const c = ctx({}, { webhookSecret, headers: job.headers as Record<string, unknown>, body: job.payload as unknown as Record<string, unknown> });
      void new ZyndTrigger().webhook.call(c).then((out: { workflowData?: { json: Record<string, unknown> }[][] }) => {
        if (!out.workflowData) return void res.writeHead(c.state.status ?? 200).end();
        then(out.workflowData[0]![0]!.json, res);
      });
    };
  }

  const challenge = async (): Promise<PaymentRequirements> => decode((await gw.send()).headers['payment-required'] as string).accepts[0];
  const pay = (r: PaymentRequirements) => ({ 'PAYMENT-SIGNATURE': gw.payments.signX402(payerSeed, r).headers['PAYMENT-SIGNATURE'] as string });
  const respondJson = (res: ServerResponse, json: unknown) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));

  it('activation: delete -> checkExists -> create -> checkExists drives the listing through the Gateway', async () => {
    gw = await makeGateway();
    const params = { listingId: gw.listing.id, responseMode: 'lastNode' };
    const h = hooks();

    expect(await h.delete.call(ctx(params))).toBe(true);
    expect((await gw.listings.get(DEV, gw.listing.id)).webhookUrl).toBeNull();
    expect(gw.beats.stopped).toContain(gw.entityId);
    expect(await h.checkExists.call(ctx(params))).toBe(false);

    expect(await h.create.call(ctx(params))).toBe(true);
    const bound = await gw.listings.get(DEV, gw.listing.id);
    expect(bound.webhookUrl).toBe(gw.webhookUrl);
    expect(gw.listings.webhookTarget(await gw.listings.getById(gw.listing.id) as never)?.secret).toBe('e2e-webhook-secret');
    expect(await h.checkExists.call(ctx(params))).toBe(true);

    // the picker sees the listing
    const opts = await new ZyndTrigger().methods.loadOptions.getListings.call(ctx(params));
    expect(opts).toEqual([{ name: 'Weather (ACTIVE)', value: gw.listing.id }]);
  });

  it('paid job, asynchronous: pay -> Gateway -> ZyndTrigger -> Zynd "Complete Job" -> A2A result, settled', async () => {
    gw = await makeGateway({ price: '0.05' });
    await hooks().create.call(ctx({ listingId: gw.listing.id }));
    let completed: unknown;
    playN8n('e2e-webhook-secret', (job, res) => {
      respondJson(res, { message: 'Workflow was started' });
      // the rest of the workflow: Zynd node, operation Complete Job, jobId from the trigger's output
      const c = ctx({ operation: 'completeJob', jobId: job.jobId, outcome: 'success', output: JSON.stringify({ forecast: 'sunny', city: (job.input as { city: string }).city }) });
      void new Zynd().execute.call(c).then(([out]: { json: unknown }[][]) => (completed = out![0]!.json));
    });

    const req = await challenge();
    const res = await gw.send({ headers: pay(req) });

    expect(res.status).toBe(200);
    expect(res.body.result.status.state).toBe('completed');
    expect(res.body.result.artifacts[0].parts[0].data).toEqual({ forecast: 'sunny', city: 'Pune' });
    expect(res.body.result.metadata).toEqual({ paymentTxn: '0xsettled' });
    expect(gw.fac.calls).toEqual(['verify', 'settle']);
    expect(completed).toMatchObject({ status: 'COMPLETED' });
  });

  it('paid job, synchronous (respond = last node): the workflow output is the A2A result', async () => {
    gw = await makeGateway({ price: '0.05' });
    await hooks().create.call(ctx({ listingId: gw.listing.id }));
    playN8n('e2e-webhook-secret', (job, res) => respondJson(res, { output: { echo: job.input } }));

    const res = await gw.send({ headers: pay(await challenge()) });
    expect(res.body.result.status.state).toBe('completed');
    expect(res.body.result.artifacts[0].parts[0].data).toEqual({ echo: { city: 'Pune' } });
    expect(gw.fac.calls).toEqual(['verify', 'settle']);
  });

  it('a job with the wrong webhook secret starts no workflow and is not charged', async () => {
    gw = await makeGateway({ price: '0.05' });
    await gw.listings.bindWebhook(DEV, gw.listing.id, { url: gw.webhookUrl, secret: WEBHOOK_SECRET }); // Gateway holds one secret...
    let ran = false;
    playN8n('a-different-secret', (_j, res) => ((ran = true), respondJson(res, { output: 1 }))); // ...the credential has another

    const res = await gw.send({ headers: pay(await challenge()) });
    expect(ran).toBe(false);
    expect(res.body.result?.status?.state ?? 'error').not.toBe('completed');
    expect(gw.fac.calls).toEqual(['verify']); // never settled
  });

  it('Zynd node: search, list listings and call an agent through the Gateway', async () => {
    gw = await makeGateway();
    remote = new FakeRemoteAgent({});
    await remote.listen();
    const REMOTE_ID = 'zns:remote0000000000000000000000001';
    gw.dns.entities.set(REMOTE_ID, { entity_id: REMOTE_ID, public_key: '', entity_url: remote.url, name: 'Remote', category: 'x', tags: [], summary: 's', developer_id: 'd' });
    gw.dns.searchResponse = { results: [{ entity_id: REMOTE_ID, name: 'Remote', summary: 's', category: 'x', tags: [], score: 1 }], total_found: 1, offset: 0, has_more: false };

    const found = await new Zynd().execute.call(ctx({ operation: 'searchAgents', query: 'remote', category: '', limit: 5, offset: 0 }));
    expect(found[0]!.map((i: { json: { entity_id: string } }) => i.json.entity_id)).toEqual([REMOTE_ID]);
    expect(gw.dns.searchCalls[0]).toEqual({ query: 'remote', max_results: 5, offset: 0 });

    const listed = await new Zynd().execute.call(ctx({ operation: 'listListings' }));
    expect(listed[0]![0].json).toMatchObject({ id: gw.listing.id, status: 'ACTIVE' });

    const called = await new Zynd().execute.call(ctx({ operation: 'callAgent', agentId: REMOTE_ID, inputType: 'json', inputJson: '{"q":"life"}', maxPaymentUsd: '' }));
    expect(called[0]![0].json).toMatchObject({ status: 'COMPLETED', output: { answer: 42 }, paymentUsd: null });

    const task = called[0]![0].json.taskId as string;
    const got = await new Zynd().execute.call(ctx({ operation: 'getTask', taskId: task }));
    expect(got[0]![0].json).toMatchObject({ taskId: task, status: 'COMPLETED' });
  });

  it('Zynd node errors read as the LLD messages', async () => {
    gw = await makeGateway();
    const run = (params: Record<string, unknown>, opts = {}) => new Zynd().execute.call(ctx(params, opts));
    await expect(run({ operation: 'listListings' }, { apiKey: 'zk_nope' })).rejects.toThrow('Invalid API key');
    await expect(run({ operation: 'callAgent', agentId: 'zns:missing', inputType: 'text', inputText: 'x', maxPaymentUsd: '' })).rejects.toThrow('Agent not found');
    gw.apiKeys.add('zk_search_only_000009', { developerId: DEV, permissions: ['search'] });
    await expect(run({ operation: 'listListings' }, { apiKey: 'zk_search_only_000009' })).rejects.toThrow('Requires permission complete');
    await expect(run({ operation: 'getTask', taskId: 'nope' })).rejects.toThrow('Task not found');
    gw.dns.searchStatus = 500;
    await expect(run({ operation: 'searchAgents', query: 'x', category: '', limit: 5, offset: 0 })).rejects.toThrow('Gateway unavailable');
  });
});

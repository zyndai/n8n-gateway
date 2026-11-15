// Studio's agent service (apps/studio/lib/agents/service.ts, S2.1 and S3) driving the real Gateway app over HTTP:
// create a draft with its own wallet, send starter credit to that wallet, publish (name, summary and price saved,
// listing registered on the registry), pause, publish again, read activity and earnings, delete. n8n is a stand-in
// and the chain is a recorder; everything on the Gateway side is real code.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AgentDnsClient } from '../src/services/AgentDnsClient.js';
import { IdentityService, keypairFromSeed, publicKeyString } from '../src/services/IdentityService.js';
import { ListingService } from '../src/services/ListingService.js';
import { PaymentProcessor } from '../src/services/PaymentProcessor.js';
import { WalletService } from '../src/services/WalletService.js';
import { encryptSecret, parseMasterKey } from '../src/services/keyVault.js';
import { AgentError, AgentService, type AgentServiceDeps } from '../apps/studio/lib/agents/service.js';
import { createGatewayClient } from '../apps/studio/lib/gateway/client.js';
import { NODE } from '../apps/studio/lib/builder/template.js';
import { FakeMcp, finishedRun } from '../apps/studio/test/helpers/fakeMcp.js';
import { goodWorkflow, ZYND_CRED, ctx } from '../apps/studio/test/helpers/readback.js';
import { FakeAgentDns } from './helpers/fakeAgentDns.js';
import { MemoryStore } from './helpers/memoryStore.js';
import { FakeBalances, MemoryAgentWallets, MemoryTasks } from './helpers/memoryStores.js';

const masterKey = parseMasterKey('ab'.repeat(32));
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const devSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SECRET = 'studio-agents-session-secret-0123456789abcdef';
const ADA = 'zns:dev:ada';
const GRACE = 'zns:dev:grace';

describe('Studio agents against the Gateway', () => {
  let server: Server;
  let dns: FakeAgentDns;
  let store: MemoryStore;
  let tasks: MemoryTasks;
  let balances: FakeBalances;
  let mcp: FakeMcp;
  let sent: [string, string][];
  let svcFor: (developerId: string, uid?: string) => AgentService;
  let gatewayUrl: string;
  /** The service's clock, moved on by hand so creations are spaced apart like real ones. */
  let clock: number;

  beforeEach(async () => {
    dns = new FakeAgentDns();
    await dns.listen();
    store = new MemoryStore();
    for (const dev of [ADA, GRACE]) {
      dns.developers.set(dev, publicKeyString(keypairFromSeed(devSeed).publicKey));
      store.keys.set(dev, { privateKeyEnc: encryptSecret(Buffer.from(devSeed).toString('base64'), masterKey), publicKey: '' });
    }
    tasks = new MemoryTasks();
    balances = new FakeBalances();
    const identity = new IdentityService({ masterKey, keySource: store });
    const wallet = new WalletService({ store, wallets: new MemoryAgentWallets(), identity, payments: new PaymentProcessor({ config: loadConfig({}).x402 }), masterKey, balances });
    const listings = new ListingService({
      store, identity, agentDns: new AgentDnsClient(dns.url),
      heartbeats: { start: () => {}, stop: async () => {} },
      publicUrl: 'https://gw.test', heartbeatRequiresWebhook: false, log: silent,
      onCreated: (l) => wallet.ensureListingWallet(l),
    });
    server = createServer(createApp({ config: { sessionJwtSecret: SECRET }, listings: () => listings, dashboard: { tasks: () => tasks, wallet: () => wallet } }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    mcp = new FakeMcp();
    sent = [];
    clock = 1_800_000_000_000;
    const gateway = createGatewayClient({ baseUrl: gatewayUrl, sessionSecret: SECRET, serviceToken: 'unused-service-token-0123456789abcdef' });
    const deps: AgentServiceDeps = {
      gateway, mcp, findCredentialId: async () => ZYND_CRED,
      treasury: { balanceUsd: async () => '100', send: async (to, amount) => (sent.push([to, amount]), '0xhash') },
      starterCreditUsd: '1', starterCreditMaxAgents: 3,
      openAiCredentialId: ctx.openAiCredentialId, agentModel: ctx.agentModel, dataSources: ctx.dataSources, maxCallPriceUsd: ctx.maxCallPriceUsd,
      now: () => clock,
    };
    let n = 0;
    svcFor = (did, uid = `uid-${did}-${++n}`) => new AgentService(deps, { uid, did, handle: 'ada-x7k2', name: 'Ada', email: 'ada@example.com' });
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await dns.close();
  });

  /** Make n8n hold a finished workflow for this agent, as the builder would have left it. */
  const build = async (svc: AgentService, id: string) => {
    mcp.workflow = goodWorkflow((nodes) => {
      for (const n of nodes) {
        if (n.parameters?.listingId) n.parameters.listingId = id;
        if (n.parameters?.payFromListingId) n.parameters.payFromListingId = id;
      }
    });
    // The relay saves the workflow id on the listing when the builder creates the workflow; do the same here.
    await createGatewayClient({ baseUrl: gatewayUrl, sessionSecret: SECRET, serviceToken: 'x'.repeat(40) }).as(svc.session.did).updateListing(id, { workflowId: 'wf-1' });
  };

  it('creates a draft with its own wallet and sends the starter credit to that wallet\'s real address', async () => {
    const svc = svcFor(ADA);
    const { id, credit } = await svc.create();
    expect(credit.status).toBe('sent');
    const listing = await svc.load(id);
    expect(listing).toMatchObject({ name: 'New agent', tags: ['zynd-studio'], status: 'DRAFT', workflowId: null });
    const wallet = await createGatewayClient({ baseUrl: gatewayUrl, sessionSecret: SECRET, serviceToken: 'x'.repeat(40) }).as(ADA).wallet();
    const address = wallet.listings.find((w) => w.listingId === id)?.address;
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(sent).toEqual([[address, '1']]);
  });

  it('gives starter credit to the first three agents only, each to its own wallet', async () => {
    const results: string[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      clock += 60_000;
      const { id, credit } = await svcFor(ADA, 'one-person').create();
      ids.push(id);
      results.push(credit.status === 'skipped' ? `skipped:${credit.reason}` : credit.status);
    }
    expect(results).toEqual(['sent', 'sent', 'sent', 'skipped:limit']);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map(([to]) => to)).size).toBe(3);
    expect(ids).toHaveLength(4);
  });

  it('keeps one person\'s agents from another: not found, never forbidden detail', async () => {
    const { id } = await svcFor(ADA).create();
    const err = (await svcFor(GRACE).load(id).catch((e: unknown) => e)) as AgentError;
    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe('not-found');
    expect((await svcFor(GRACE).create()).id).not.toBe(id);
    expect((await svcFor(ADA).load(id)).id).toBe(id);
  });

  it('does not treat a dashboard listing as a Studio agent', async () => {
    const dashboard = await createGatewayClient({ baseUrl: gatewayUrl, sessionSecret: SECRET, serviceToken: 'x'.repeat(40) })
      .as(ADA)
      .createListing({ name: 'Dashboard agent', summary: 's', category: 'general', tags: ['weather'] });
    const err = (await svcFor(ADA).load(dashboard.id).catch((e: unknown) => e)) as AgentError;
    expect(err.code).toBe('not-found');
    expect((await svcFor(ADA).remove(dashboard.id).catch((e: unknown) => e)) as AgentError).toMatchObject({ code: 'not-found' });
  });

  it('publish, pause, publish again, delete: the whole life of an agent', async () => {
    const svc = svcFor(ADA);
    const { id } = await svc.create();
    await build(svc, id);

    // Publish: details saved, workflow turned on, listing registered on the network.
    const live = await svc.publish(id, { name: 'Supplier Check', summary: 'Checks a new supplier before you pay them.', priceUsd: '0.15' });
    expect(live).toMatchObject({ status: 'ACTIVE', name: 'Supplier Check', priceUsd: '0.15' });
    expect(live.entityId).toMatch(/^zns:[0-9a-f]{32}$/);
    const registered = dns.entities.get(live.entityId as string) as { name?: string; summary?: string } | undefined;
    expect(registered).toMatchObject({ name: 'Supplier Check', summary: 'Checks a new supplier before you pay them.' });
    expect(mcp.callsTo('publish_workflow')).toHaveLength(1);
    expect(dns.registerCalls).toBe(1);

    // Pause: the workflow goes off and the listing is paused.
    await svc.pause(id);
    expect((await svc.load(id)).status).toBe('INACTIVE');
    expect(mcp.callsTo('unpublish_workflow')).toHaveLength(1);

    // Publish again: back live under the same identity, no second registration.
    const again = await svc.publish(id, { name: 'Supplier Check', summary: 'Checks a new supplier before you pay them.', priceUsd: '0.20' });
    expect(again).toMatchObject({ status: 'ACTIVE', entityId: live.entityId, priceUsd: '0.20' });
    expect(dns.registerCalls).toBe(1);

    // Delete: workflow off and archived, listing gone.
    await svc.remove(id);
    expect(mcp.callsTo('archive_workflow')).toHaveLength(1);
    expect((await svc.load(id).catch((e: unknown) => e)) as AgentError).toMatchObject({ code: 'not-found' });
    expect(await createGatewayClient({ baseUrl: gatewayUrl, sessionSecret: SECRET, serviceToken: 'x'.repeat(40) }).as(ADA).listListings()).toEqual([]);
  });

  it('does not go live when the registry is down, and turns the workflow back off', async () => {
    const svc = svcFor(ADA);
    const { id } = await svc.create();
    await build(svc, id);
    dns.failRegistration = true;
    const err = (await svc.publish(id, { name: 'X', summary: 'y', priceUsd: '0.10' }).catch((e: unknown) => e)) as AgentError;
    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe('registration');
    expect(mcp.callsTo('unpublish_workflow')).toHaveLength(1);
    expect((await svc.load(id)).status).not.toBe('ACTIVE');
  });

  it('shows earnings and uses by other agents from the Gateway\'s own history', async () => {
    const svc = svcFor(ADA);
    const { id } = await svc.create();
    await build(svc, id);
    const done = await tasks.create({ developerId: ADA, listingId: id, callerId: 'zns:caller', direction: 'INBOUND', input: {}, paymentUsd: '0.15' });
    await tasks.transition(done.id, ['PENDING'], 'COMPLETED');
    await tasks.setPayment(done.id, { paymentTxn: '0xtxn', paymentUsd: '0.15' });
    const failed = await tasks.create({ developerId: ADA, listingId: id, callerId: 'zns:caller2', direction: 'INBOUND', input: {} });
    await tasks.transition(failed.id, ['PENDING'], 'FAILED', { error: 'boom' });
    // A task of another developer's listing never appears.
    await tasks.create({ developerId: GRACE, listingId: 'other', callerId: 'zns:z', direction: 'INBOUND', input: {} });

    mcp.searchResults = { data: [{ id: '9', status: 'success', mode: 'chat', startedAt: new Date().toISOString() }] };
    mcp.executions.set('9', finishedRun({ request: 'Check ACME Ltd' }));

    const items = await svc.activity(id);
    expect(items.map((i) => [i.kind, i.ok])).toContainEqual(['you', true]);
    expect(items.filter((i) => i.kind === 'other').map((i) => [i.ok, i.amountUsd]).sort()).toEqual([[false, '0'], [true, '0.15']]);
    expect(JSON.stringify(items)).not.toMatch(/boom|zns:caller/);
    expect((await svc.earnings()).get(id)).toBe('0.150000');
  });

  it('runs a chat through the same checks, as the signed-in developer only', async () => {
    const svc = svcFor(ADA);
    const { id } = await svc.create();
    await build(svc, id);
    const { executionId, mode } = await svc.startChat(id, 'Check ACME');
    expect(mode).toBe('manual');
    mcp.executions.set(executionId, finishedRun({ answer: 'Looks fine.' }));
    expect(await svc.readChat(id, executionId)).toMatchObject({ status: 'success', answer: 'Looks fine.' });
    // Another person cannot reach it by id.
    expect(((await svcFor(GRACE).startChat(id, 'hi').catch((e: unknown) => e)) as AgentError).code).toBe('not-found');
    expect(((await svcFor(GRACE).readChat(id, executionId).catch((e: unknown) => e)) as AgentError).code).toBe('not-found');
    expect(NODE.chat).toBe('Chat Trigger');
  });
});

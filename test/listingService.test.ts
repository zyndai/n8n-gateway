import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDnsClient, type RegisterEntityBody as RegisterBody } from '../src/services/AgentDnsClient.js';
import { IdentityService, keypairFromSeed, publicKeyString } from '../src/services/IdentityService.js';
import { ListingService } from '../src/services/ListingService.js';
import { encryptSecret, parseMasterKey } from '../src/services/keyVault.js';
import { FakeAgentDns } from './helpers/fakeAgentDns.js';
import { MemoryStore } from './helpers/memoryStore.js';

const masterKey = parseMasterKey('ab'.repeat(32));
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const DEV = 'zns:dev:aaaa';
const devSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const input = { name: 'Weather', summary: 'Forecasts', category: 'general', tags: ['weather'] };

let dns: FakeAgentDns;
let store: MemoryStore;
let started: { listingId: string; entityId: string }[];
let stopped: string[];
let heartbeats: { start: (a: { listingId: string; entityId: string }) => void; stop: (id: string) => Promise<void> };
let identity: IdentityService;
let svc: ListingService;
let keyLoads: number;

async function build(opts: { requiresWebhook?: boolean } = {}) {
  dns = new FakeAgentDns();
  await dns.listen();
  dns.developers.set(DEV, publicKeyString(keypairFromSeed(devSeed).publicKey));
  store = new MemoryStore();
  store.keys.set(DEV, { privateKeyEnc: encryptSecret(Buffer.from(devSeed).toString('base64'), masterKey), publicKey: '' });
  keyLoads = 0;
  const source = { getDeveloperKey: (id: string) => (keyLoads++, store.getDeveloperKey(id)) };
  identity = new IdentityService({ masterKey, keySource: source });
  started = [];
  stopped = [];
  heartbeats = {
    start: (a) => started.push(a),
    stop: async (id) => void stopped.push(id),
  };
  svc = new ListingService({
    store,
    identity,
    agentDns: new AgentDnsClient(dns.url),
    heartbeats,
    publicUrl: 'https://gw.test',
    heartbeatRequiresWebhook: opts.requiresWebhook ?? false,
    log: silent,
  });
}

beforeEach(() => build());
afterEach(async () => {
  await dns.close();
});

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('create (M1.2)', () => {
  it('allocates increasing, never-reused derivation indexes per developer', async () => {
    store.keys.set('zns:dev:bbbb', { privateKeyEnc: '', publicKey: '' });
    const a = await svc.create(DEV, input);
    const b = await svc.create(DEV, input);
    const other = await svc.create('zns:dev:bbbb', input);
    expect([a.derivedKeyIndex, b.derivedKeyIndex, other.derivedKeyIndex]).toEqual([0, 1, 0]);
    expect(a.status).toBe('DRAFT');
    expect(a.entityId).toBeNull();
  });
  it('404s for an unknown developer', async () => {
    await expect(svc.create('zns:dev:nobody', input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('activate: registration flow (M1.7)', () => {
  it('registers a verifiable entity and goes ACTIVE with the gateway entity_url', async () => {
    const l = await svc.create(DEV, { ...input, tags: ['b', 'a'] });
    const out = await svc.activate(DEV, l.id);

    // The fake registry verified the canonical-JSON signature and derivation proof, like Go does.
    expect(dns.registerCalls).toBe(1);
    const agent = identity.deriveKeypair(devSeed, l.derivedKeyIndex);
    const entity = [...dns.entities.values()][0];
    expect(entity?.public_key).toBe(publicKeyString(agent.publicKey));
    expect(entity?.developer_id).toBe(DEV);

    expect(out.status).toBe('ACTIVE');
    expect(out.entityId).toBe(entity?.entity_id);
    expect(out.entityUrl).toBe(`https://gw.test/a/${entity?.entity_id}`);
    expect(entity?.entity_url).toBe(out.entityUrl);
  });

  it('starts the heartbeat with the derived keypair', async () => {
    const l = await svc.create(DEV, input);
    const out = await svc.activate(DEV, l.id);
    await flush();
    expect(started).toEqual([expect.objectContaining({ listingId: l.id, entityId: out.entityId })]);
  });

  it('each listing registers a distinct identity', async () => {
    const a = await svc.activate(DEV, (await svc.create(DEV, input)).id);
    const b = await svc.activate(DEV, (await svc.create(DEV, input)).id);
    expect(a.entityId).not.toBe(b.entityId);
  });

  it('decrypts the developer key only for the proof, not on later heartbeat starts', async () => {
    const l = await svc.create(DEV, input);
    await svc.activate(DEV, l.id);
    const afterActivate = keyLoads;
    expect(afterActivate).toBe(2); // once for the agent key (cached), once for the proof
    await svc.activate(DEV, l.id); // already ACTIVE: ensureHeartbeat reuses the cached keypair
    await flush();
    expect(keyLoads).toBe(afterActivate);
  });

  it('is idempotent for an ACTIVE listing', async () => {
    const l = await svc.create(DEV, input);
    await svc.activate(DEV, l.id);
    await svc.activate(DEV, l.id);
    expect(dns.registerCalls).toBe(1);
  });

  it('sets ERROR and surfaces GATEWAY_UNAVAILABLE when AgentDNS fails, then recovers on retry', async () => {
    const l = await svc.create(DEV, input);
    dns.failRegistration = true;
    await expect(svc.activate(DEV, l.id)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE', status: 502 });
    expect((await svc.get(DEV, l.id)).status).toBe('ERROR');
    expect(started).toHaveLength(0);

    dns.failRegistration = false;
    const out = await svc.activate(DEV, l.id);
    expect(out.status).toBe('ACTIVE');
  });

  it('sets ERROR when the registry rejects the developer proof', async () => {
    const l = await svc.create(DEV, input);
    dns.developers.set(DEV, publicKeyString(keypairFromSeed(new Uint8Array(32).fill(5)).publicKey));
    await expect(svc.activate(DEV, l.id)).rejects.toMatchObject({
      code: 'GATEWAY_UNAVAILABLE',
      details: expect.objectContaining({ agentDnsStatus: 400 }),
    });
    expect((await svc.get(DEV, l.id)).status).toBe('ERROR');
  });

  it('treats 409 as success when the registry already holds our key (crash between register and DB write)', async () => {
    const l = await svc.create(DEV, input);
    await svc.activate(DEV, l.id);
    // Simulate: DB write lost, listing back in ERROR with no entityId.
    store.patch(l.id, { status: 'ERROR', entityId: null });
    const out = await svc.activate(DEV, l.id);
    expect(dns.registerCalls).toBe(2);
    expect(out.status).toBe('ACTIVE');
    expect(dns.entities.size).toBe(1);
  });

  it('refuses a concurrent activation while another is fresh, but takes over a stale REGISTERING', async () => {
    const l = await svc.create(DEV, input);
    store.patch(l.id, { status: 'REGISTERING' });
    await expect(svc.activate(DEV, l.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    store.age(l.id, 3 * 60_000);
    expect((await svc.activate(DEV, l.id)).status).toBe('ACTIVE');
  });

  it('only one of two simultaneous activations registers', async () => {
    const l = await svc.create(DEV, input);
    const results = await Promise.allSettled([svc.activate(DEV, l.id), svc.activate(DEV, l.id)]);
    expect(dns.registerCalls).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await svc.get(DEV, l.id)).status).toBe('ACTIVE');
  });
});

describe('ownership', () => {
  it('answers 404 for another developer\'s listing on every operation', async () => {
    const l = await svc.create(DEV, input);
    for (const op of [() => svc.get('zns:dev:evil', l.id), () => svc.activate('zns:dev:evil', l.id), () => svc.deactivate('zns:dev:evil', l.id)]) {
      await expect(op()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(await svc.list('zns:dev:evil')).toEqual([]);
    expect(dns.registerCalls).toBe(0);
  });
});

describe('deactivate (M1.3 invalidation)', () => {
  it('stops the heartbeat, drops the cached keypair, and keeps the registration', async () => {
    const l = await svc.create(DEV, input);
    const active = await svc.activate(DEV, l.id);
    await flush();
    expect(identity.cacheSize).toBe(1);

    const out = await svc.deactivate(DEV, l.id);
    expect(out.status).toBe('INACTIVE');
    expect(stopped).toEqual([active.entityId]);
    expect(identity.cacheSize).toBe(0);
    expect(out.entityId).toBe(active.entityId);
  });

  it('re-activation of a registered INACTIVE listing does not register again', async () => {
    const l = await svc.create(DEV, input);
    await svc.activate(DEV, l.id);
    await svc.deactivate(DEV, l.id);
    const out = await svc.activate(DEV, l.id);
    expect(out.status).toBe('ACTIVE');
    expect(dns.registerCalls).toBe(1);
    await flush();
    expect(started).toHaveLength(2);
  });

  it('is idempotent on INACTIVE and refuses DRAFT', async () => {
    const l = await svc.create(DEV, input);
    await expect(svc.deactivate(DEV, l.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await svc.activate(DEV, l.id);
    await svc.deactivate(DEV, l.id);
    expect((await svc.deactivate(DEV, l.id)).status).toBe('INACTIVE');
  });
});

describe('G7: heartbeat only once a webhook exists', () => {
  beforeEach(async () => {
    await dns.close();
    await build({ requiresWebhook: true });
  });

  it('registers but does not heartbeat until a webhook is bound', async () => {
    const l = await svc.create(DEV, input);
    const out = await svc.activate(DEV, l.id);
    await flush();
    expect(out.status).toBe('ACTIVE');
    expect(started).toHaveLength(0);

    // M2.5 will bind the webhook and call ensureHeartbeat.
    svc.ensureHeartbeat(store.patch(l.id, { webhookUrl: 'https://n8n.test/hook' }));
    await flush();
    expect(started).toHaveLength(1);
  });

  it('loadActive omits webhook-less listings only when required', async () => {
    const l = await svc.create(DEV, input);
    await svc.activate(DEV, l.id);
    expect(await store.loadActive(true)).toHaveLength(0);
    expect(await store.loadActive(false)).toHaveLength(1);
  });
});

describe('registration payload (what AgentDNS sees)', () => {
  it('verifies independently of the fake registry', async () => {
    const seen: RegisterBody[] = [];
    const real = fetch;
    const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') seen.push(JSON.parse(init.body as string));
      return real(url, init);
    });
    svc = new ListingService({
      store, identity, agentDns: new AgentDnsClient(dns.url, spy as typeof fetch), heartbeats,
      publicUrl: 'https://gw.test', heartbeatRequiresWebhook: false, log: silent,
    });
    const l = await svc.create(DEV, input);
    await svc.activate(DEV, l.id);
    const body = seen[0] as RegisterBody;
    expect(Object.keys(body).sort()).toEqual(
      ['category', 'developer_id', 'developer_proof', 'entity_url', 'name', 'public_key', 'signature', 'summary', 'tags'],
    );
    const dev = keypairFromSeed(devSeed);
    expect(body.developer_proof.developer_public_key).toBe(publicKeyString(dev.publicKey));
    expect(body.developer_proof.entity_index).toBe(l.derivedKeyIndex);
    expect(ed25519.getPublicKey(identity.deriveKeypair(devSeed, l.derivedKeyIndex).privateKey)).toEqual(
      Uint8Array.from(Buffer.from(body.public_key.slice(8), 'base64')),
    );
  });
});

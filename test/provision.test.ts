import { ed25519 } from '@noble/curves/ed25519.js';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ApiError } from '../src/errors.js';
import { AgentDnsClient } from '../src/services/AgentDnsClient.js';
import { ProvisionService, isValidHandle, makeHandle } from '../src/services/ProvisionService.js';
import { decryptSecret, encryptSecret, parseMasterKey } from '../src/services/keyVault.js';
import { FakeAgentDns } from './helpers/fakeAgentDns.js';
import { TEST_SECRET, inMinutes, mintToken } from './helpers/jwt.js';
import { MemoryDevelopers } from './helpers/memoryDevelopers.js';

const masterKey = parseMasterKey('ab'.repeat(32));
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const SERVICE_TOKEN = 'studio-service-token-0123456789abcdef0123456789';

/** A random() that returns the given values in turn, then 0s. 4 values make one handle suffix. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++] ?? 0;
};

describe('makeHandle', () => {
  it('slugs the name and adds 4 random characters', () => {
    expect(makeHandle('Ada Lovelace', sequence(0, 1, 2, 3))).toBe('ada-lovelace-abcd');
    expect(makeHandle('  José Núñez  ', sequence(26, 27, 28, 29))).toBe('jose-nunez-0123');
  });

  it('falls back to "user" when the name has no usable letters, and prefixes names that start with a digit', () => {
    expect(makeHandle('李小龙', sequence(0, 0, 0, 0))).toBe('user-aaaa');
    expect(makeHandle('', sequence(0, 0, 0, 0))).toBe('user-aaaa');
    expect(makeHandle('42 Club', sequence(0, 0, 0, 0))).toBe('user-42-club-aaaa');
  });

  it('always yields a handle the registry accepts, however odd the name', () => {
    const names = ['A', 'a-', '--x--', 'x'.repeat(200), 'Mary-Jane O\'Neil-Smith III', '!!!', 'Ünï©ødé', 'a b', '_under_score_'];
    for (const name of names) for (let i = 0; i < 20; i++) expect(isValidHandle(makeHandle(name)), name).toBe(true);
  });
});

describe('ProvisionService', () => {
  let dns: FakeAgentDns;
  let devs: MemoryDevelopers;
  let svc: ProvisionService;

  const make = (random?: (n: number) => number) =>
    new ProvisionService({ directory: devs, registry: new AgentDnsClient(dns.url), adminSecret: dns.adminSecret, masterKey, log: silent, ...(random ? { random } : {}) });

  beforeEach(async () => {
    dns = new FakeAgentDns();
    await dns.listen();
    devs = new MemoryDevelopers();
    svc = make();
  });
  afterEach(() => dns.close());

  it('creates a developer for a new user: approved, key re-encrypted, handle claimed and verified', async () => {
    const out = await svc.provision('user-1', 'Ada Lovelace');
    expect(out.created).toBe(true);
    expect(out.developerId).toMatch(/^zns:dev:[0-9a-f]{32}$/);
    expect(out.handle).toMatch(/^ada-lovelace-[a-z0-9]{4}$/);
    expect(out.name).toBe('Ada Lovelace');

    // The row holds the registry's key under OUR master key, byte-for-byte what the registry issued.
    const row = devs.byUser.get('user-1')!;
    const issued = dns.issuedKeys.get(out.developerId)!;
    expect(row.developerId).toBe(out.developerId);
    expect(row.publicKey).toBe(issued.publicKey);
    expect(decryptSecret(row.privateKeyEnc, masterKey)).toBe(issued.privateKeyB64);
    expect(row.username).toBe(out.handle);

    // The registry has the handle, signed by the developer's key, and verified.
    expect(dns.handles.get(out.handle)).toEqual({ developer_id: out.developerId, verified: true });
    expect(dns.approveCalls).toBe(1);
  });

  it('is idempotent: a second call returns the same developer and creates nothing', async () => {
    const first = await svc.provision('user-1', 'Ada Lovelace');
    const second = await svc.provision('user-1', 'A different name now');
    expect(second).toEqual({ ...first, created: false });
    expect(dns.approveCalls).toBe(1);
    expect(dns.claimCalls).toBe(1);
    expect(devs.byUser.size).toBe(1);
  });

  it('returns a dashboard developer that already has a handle without touching the registry', async () => {
    devs.byUser.set('dash-user', { userId: 'dash-user', developerId: 'zns:dev:dash', name: 'Dash Dev', username: 'dash-dev', publicKey: '', privateKeyEnc: 'x' });
    expect(await svc.provision('dash-user', 'Google Name')).toEqual({ developerId: 'zns:dev:dash', handle: 'dash-dev', name: 'Dash Dev', created: false });
    expect(dns.approveCalls + dns.claimCalls).toBe(0);
  });

  it('gives a handle to a developer that has none, signing with their key', async () => {
    // A developer created elsewhere (the dashboard) before the handle step.
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
    const pub = `ed25519:${Buffer.from(ed25519.getPublicKey(seed)).toString('base64')}`;
    dns.developers.set('zns:dev:nohandle', pub);
    devs.byUser.set('u2', {
      userId: 'u2', developerId: 'zns:dev:nohandle', name: 'Grace Hopper', username: null, publicKey: pub,
      // Stored as the base64 of seed || public, the 64-byte Go form.
      privateKeyEnc: encryptSecret(Buffer.concat([seed, ed25519.getPublicKey(seed)]).toString('base64'), masterKey),
    });
    const out = await svc.provision('u2', 'Ignored');
    expect(out).toMatchObject({ developerId: 'zns:dev:nohandle', created: false });
    expect(out.handle).toMatch(/^grace-hopper-[a-z0-9]{4}$/);
    expect(devs.byUser.get('u2')!.username).toBe(out.handle);
    expect(dns.handles.get(out.handle)?.verified).toBe(true);
    expect(dns.approveCalls).toBe(0);
  });

  it('serialises two sign-ins of the same user: one registry developer', async () => {
    const [a, b] = await Promise.all([svc.provision('user-1', 'Ada'), svc.provision('user-1', 'Ada')]);
    expect(a.developerId).toBe(b.developerId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(dns.approveCalls).toBe(1);
  });

  it('keeps going for different users at the same time', async () => {
    const out = await Promise.all(['a', 'b', 'c'].map((u) => svc.provision(u, `User ${u}`)));
    expect(new Set(out.map((o) => o.developerId)).size).toBe(3);
    expect(new Set(out.map((o) => o.handle)).size).toBe(3);
  });

  it('tries another handle when one is taken on the registry or in the database', async () => {
    // Suffixes: "aaaa" (taken on the registry), "bbbb" (taken locally), "cccc" (free).
    dns.handles.set('ada-aaaa', { developer_id: 'zns:dev:other', verified: true });
    devs.byUser.set('other', { userId: 'other', developerId: 'zns:dev:o2', name: 'O', username: 'ada-bbbb', publicKey: '', privateKeyEnc: 'x' });
    const out = await make(sequence(0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2)).provision('user-1', 'Ada');
    expect(out.handle).toBe('ada-cccc');
  });

  it('survives a claim that answers 409 after the availability check passed', async () => {
    // Between the availability check and the claim someone takes "ada-aaaa".
    const real = new AgentDnsClient(dns.url);
    let first = true;
    const registry = {
      approveDeveloper: real.approveDeveloper.bind(real),
      handleAvailable: async (h: string) => {
        const free = await real.handleAvailable(h);
        if (first) { first = false; dns.handles.set(h, { developer_id: 'zns:dev:racer', verified: false }); }
        return free;
      },
      claimHandle: real.claimHandle.bind(real),
      verifyHandle: real.verifyHandle.bind(real),
    };
    const s = new ProvisionService({ directory: devs, registry, adminSecret: dns.adminSecret, masterKey, log: silent, random: sequence(0, 0, 0, 0, 1, 1, 1, 1) });
    expect((await s.provision('user-1', 'Ada')).handle).toBe('ada-bbbb');
  });

  it('answers 502 and stores nothing when the registry is down at approval', async () => {
    dns.failApprove = true;
    await expect(svc.provision('user-1', 'Ada')).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE', status: 502 });
    expect(devs.byUser.size).toBe(0);
  });

  it('answers 502 when the registry rejects the admin secret', async () => {
    const bad = new ProvisionService({ directory: devs, registry: new AgentDnsClient(dns.url), adminSecret: 'wrong', masterKey, log: silent });
    await expect(bad.provision('user-1', 'Ada')).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE', details: { agentDnsStatus: 401 } });
  });

  it('keeps the developer when the handle step fails, and a retry only adds the handle', async () => {
    dns.failClaim = true;
    await expect(svc.provision('user-1', 'Ada')).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
    expect(devs.byUser.get('user-1')).toMatchObject({ username: null });
    expect(dns.approveCalls).toBe(1);

    dns.failClaim = false;
    const out = await svc.provision('user-1', 'Ada');
    expect(out.created).toBe(false);
    expect(out.handle).toMatch(/^ada-[a-z0-9]{4}$/);
    expect(dns.approveCalls).toBe(1); // no second registry developer
  });

  it('uses the existing developer when another process created it between the check and the insert', async () => {
    // The lookup finds nothing; just before the insert, the dashboard creates the user's developer.
    const insert = devs.insert.bind(devs);
    devs.insert = async (d) => {
      devs.byUser.set(d.userId, { userId: d.userId, developerId: 'zns:dev:dash', name: 'Dash', username: 'dash-1', publicKey: '', privateKeyEnc: 'x' });
      return insert(d);
    };
    const out = await svc.provision('user-1', 'Ada');
    expect(out).toEqual({ developerId: 'zns:dev:dash', handle: 'dash-1', name: 'Dash', created: false });
  });

  it('gives up with CONFLICT when every handle is taken', async () => {
    const s = make(() => 0); // always "aaaa"
    dns.handles.set('ada-aaaa', { developer_id: 'x', verified: true });
    await expect(s.provision('user-1', 'Ada')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(devs.byUser.get('user-1')).toMatchObject({ username: null });
  });

  it('never puts key material in an error', async () => {
    devs.byUser.set('u', { userId: 'u', developerId: 'zns:dev:bad', name: 'X', username: null, publicKey: '', privateKeyEnc: 'not-a-ciphertext' });
    const err = (await svc.provision('u', 'X').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('INTERNAL');
    expect(JSON.stringify(err.toBody())).not.toContain('not-a-ciphertext');
  });
});

describe('POST /internal/v1/provision', () => {
  const calls: [string, string][] = [];
  const fake = {
    provision: async (userId: string, name: string) => {
      calls.push([userId, name]);
      return { developerId: 'zns:dev:abc', handle: 'ada-x7k2', name, created: calls.length === 1 };
    },
  };
  const appWith = (studioServiceToken: string | undefined) =>
    createApp({ config: { sessionJwtSecret: TEST_SECRET, ...(studioServiceToken ? { studioServiceToken } : {}) }, provision: { provisioner: () => fake as unknown as ProvisionService } });
  const post = (app: ReturnType<typeof createApp>, auth?: string) => {
    const r = request(app).post('/internal/v1/provision');
    return auth ? r.set('Authorization', auth) : r;
  };

  beforeEach(() => void (calls.length = 0));

  it('requires the service token', async () => {
    const app = appWith(SERVICE_TOKEN);
    for (const auth of [undefined, 'Bearer nope', `Bearer ${SERVICE_TOKEN}x`, `Bearer ${SERVICE_TOKEN.slice(1)}`, SERVICE_TOKEN]) {
      const res = await post(app, auth).send({ userId: 'u', name: 'Ada' });
      expect(res.status, String(auth)).toBe(401);
      expect(res.body.code).toBe('AUTH_INVALID');
    }
    expect(calls).toHaveLength(0);
  });

  it('does not accept a Session JWT in place of the service token', async () => {
    const jwt = mintToken({ sub: 'zns:dev:alice', exp: inMinutes(5) });
    expect((await post(appWith(SERVICE_TOKEN), `Bearer ${jwt}`).send({ userId: 'u', name: 'Ada' })).status).toBe(401);
  });

  it('creates (201) then returns (200) and passes the name through', async () => {
    const app = appWith(SERVICE_TOKEN);
    const first = await post(app, `Bearer ${SERVICE_TOKEN}`).send({ userId: ' user-1 ', name: 'Ada Lovelace' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ developerId: 'zns:dev:abc', handle: 'ada-x7k2', name: 'Ada Lovelace', created: true });
    const second = await post(app, `Bearer ${SERVICE_TOKEN}`).send({ userId: 'user-1', name: 'Ada Lovelace' });
    expect(second.status).toBe(200);
    expect(calls[0]).toEqual(['user-1', 'Ada Lovelace']);
  });

  it('accepts a missing name and rejects a bad body', async () => {
    const app = appWith(SERVICE_TOKEN);
    expect((await post(app, `Bearer ${SERVICE_TOKEN}`).send({ userId: 'u' })).status).toBe(201);
    for (const body of [{}, { userId: '' }, { userId: 5 }, { userId: 'u', name: 5 }, { userId: 'x'.repeat(101) }, [], 'text']) {
      const res = await post(app, `Bearer ${SERVICE_TOKEN}`).send(body as object);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('does not exist without a usable token: the request falls through to the Session JWT check', async () => {
    for (const token of [undefined, 'too-short']) {
      const res = await post(appWith(token), `Bearer ${token ?? SERVICE_TOKEN}`).send({ userId: 'u', name: 'Ada' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid session token');
    }
    expect(calls).toHaveLength(0);
  });

  it('answers 502 when the Gateway has no registry admin secret', async () => {
    const app = createApp({ config: { sessionJwtSecret: TEST_SECRET, studioServiceToken: SERVICE_TOKEN }, provision: { provisioner: () => { throw new ApiError('GATEWAY_UNAVAILABLE', 'Studio provisioning is not configured on this Gateway'); } } });
    const res = await post(app, `Bearer ${SERVICE_TOKEN}`).send({ userId: 'u', name: 'Ada' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('GATEWAY_UNAVAILABLE');
  });
});

// Zynd Studio's first-sign-in setup (apps/studio/lib/setup.ts, S1.3) driving the real Gateway app over HTTP:
// provision -> API key -> n8n credential. The registry is the fake AgentDNS, n8n is an in-memory stand-in that
// records what it is given. Also pins that Studio's Session JWT is accepted by the Gateway (S1.2/S1.3 contract).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { verifySessionToken } from '../src/middleware/sessionAuth.js';
import { AgentDnsClient } from '../src/services/AgentDnsClient.js';
import { ApiKeyService } from '../src/services/ApiKeyService.js';
import { IdentityService } from '../src/services/IdentityService.js';
import { ListingService } from '../src/services/ListingService.js';
import { ProvisionService } from '../src/services/ProvisionService.js';
import { parseMasterKey } from '../src/services/keyVault.js';
import { createGatewayClient, GatewayError, type GatewayClient } from '../apps/studio/lib/gateway/client.js';
import { mintSessionToken } from '../apps/studio/lib/gateway/token.js';
import { CREDENTIAL_TYPE, KEY_NAME, SetupError, credentialName, displayName, setupUser, type SetupDeps } from '../apps/studio/lib/setup.js';
import { FakeAgentDns } from './helpers/fakeAgentDns.js';
import { MemoryDevelopers } from './helpers/memoryDevelopers.js';
import { MemoryStore } from './helpers/memoryStore.js';
import { MemoryApiKeys } from './helpers/memoryStores.js';

const masterKey = parseMasterKey('ab'.repeat(32));
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const SESSION_SECRET = 'studio-interop-session-secret-0123456789abcdef';
const SERVICE_TOKEN = 'studio-interop-service-token-0123456789abcdef';

interface N8nCredential {
  id: string;
  name: string;
  type: string;
  data: Record<string, string>;
}

describe('Studio setup against the Gateway', () => {
  let server: Server;
  let dns: FakeAgentDns;
  let developers: MemoryDevelopers;
  let keys: MemoryApiKeys;
  let gateway: GatewayClient;
  let credentials: N8nCredential[];
  let failCredential: boolean;
  let deps: SetupDeps;
  let gatewayUrl: string;

  beforeEach(async () => {
    dns = new FakeAgentDns();
    await dns.listen();
    developers = new MemoryDevelopers();
    keys = new MemoryApiKeys();
    const store = new MemoryStore();
    const listings = new ListingService({
      store, identity: new IdentityService({ masterKey, keySource: store }), agentDns: new AgentDnsClient(dns.url),
      heartbeats: { start: () => {}, stop: async () => {} }, publicUrl: 'https://gw.test', heartbeatRequiresWebhook: false, log: silent,
    });
    const provisioner = new ProvisionService({ directory: developers, registry: new AgentDnsClient(dns.url), adminSecret: dns.adminSecret, masterKey, log: silent });
    const known = async (id: string) => [...developers.byUser.values()].some((d) => d.developerId === id);
    const app = createApp({
      config: { sessionJwtSecret: SESSION_SECRET, studioServiceToken: SERVICE_TOKEN },
      listings: () => listings,
      provision: { provisioner: () => provisioner },
      dashboard: { apiKeys: () => new ApiKeyService({ store: keys, developerExists: known }) },
      n8n: { apiKeys: () => keys },
    });
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    gateway = createGatewayClient({ baseUrl: gatewayUrl, sessionSecret: SESSION_SECRET, serviceToken: SERVICE_TOKEN });
    credentials = [];
    failCredential = false;
    deps = {
      gateway,
      n8n: {
        findCredentials: async (type, name) => credentials.filter((c) => c.type === type && c.name === name),
        createCredential: async (body) => {
          if (failCredential) throw new Error('n8n is down');
          const c = { id: `cred-${credentials.length + 1}`, ...body };
          credentials.push(c);
          return c;
        },
      },
      gatewayUrlForN8n: 'http://gateway:8080',
      spendCapUsd: '5',
      log: silent,
    };
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await dns.close();
  });

  const user = { id: 'supabase-user-1', name: 'Ada Lovelace', email: 'ada@example.com' };
  const activeKeys = () => [...keys.rows.values()].filter((k) => !k.revokedAt && (!k.expiresAt || k.expiresAt > new Date()));

  it('turns a Google sign-in into a developer, a handle, one key and one n8n credential', async () => {
    const session = await setupUser(deps, user);

    expect(session).toMatchObject({ uid: user.id, name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(session.did).toMatch(/^zns:dev:[0-9a-f]{32}$/);
    expect(session.handle).toMatch(/^ada-lovelace-[a-z0-9]{4}$/);
    expect(dns.handles.get(session.handle)).toEqual({ developer_id: session.did, verified: true });

    // One key, named for Studio, capped, with exactly the permissions the nodes need.
    expect(keys.rows.size).toBe(1);
    const key = [...keys.rows.values()][0];
    expect(key).toMatchObject({ developerId: session.did, name: KEY_NAME, permissions: ['search', 'call', 'complete'] });
    expect(Number(key?.spendCapUsd)).toBe(5);

    // One credential, named after the handle, holding the Gateway address for n8n, the key and a webhook secret.
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ name: credentialName(session.handle), type: CREDENTIAL_TYPE });
    expect(credentials[0]?.data.apiUrl).toBe('http://gateway:8080');
    expect(credentials[0]?.data.webhookSecret).toMatch(/^[0-9a-f]{48}$/);
  });

  it('puts a key into the credential that the Gateway accepts for n8n calls', async () => {
    await setupUser(deps, user);
    const key = credentials[0]?.data.apiKey as string;
    const res = await fetch(`${gatewayUrl}/n8n/v1/listings`, { headers: { 'X-Zynd-Api-Key': key } });
    expect(res.status).toBe(200);
    expect((await fetch(`${gatewayUrl}/n8n/v1/listings`, { headers: { 'X-Zynd-Api-Key': `${key}x` } })).status).toBe(401);
  });

  it('signing in twice creates exactly one developer, one key and one credential', async () => {
    const first = await setupUser(deps, user);
    const second = await setupUser(deps, user);
    expect(second).toEqual(first);
    expect(dns.approveCalls).toBe(1);
    expect(keys.rows.size).toBe(1);
    expect(credentials).toHaveLength(1);
  });

  it('two sign-ins at once (a double click) still create one of each', async () => {
    const [a, b] = await Promise.all([setupUser(deps, user), setupUser(deps, user)]);
    expect(a).toEqual(b);
    expect(keys.rows.size).toBe(1);
    expect(credentials).toHaveLength(1);
  });

  it('gives different people different developers, handles and credentials', async () => {
    const grace = { id: 'supabase-user-2', name: 'Grace Hopper', email: 'grace@example.com' };
    const [a, b] = await Promise.all([setupUser(deps, user), setupUser(deps, grace)]);
    expect(a.did).not.toBe(b.did);
    expect(new Set(credentials.map((c) => c.name)).size).toBe(2);
    expect(new Set([...keys.rows.values()].map((k) => k.developerId)).size).toBe(2);
  });

  it('when n8n refuses the credential, the key is revoked and the retry starts clean', async () => {
    failCredential = true;
    const err = await setupUser(deps, user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetupError);
    expect((err as SetupError).step).toBe('credential');
    expect(credentials).toHaveLength(0);
    expect(activeKeys()).toHaveLength(0); // the key nobody could read is not left working

    failCredential = false;
    await setupUser(deps, user);
    expect(credentials).toHaveLength(1);
    expect(activeKeys()).toHaveLength(1);
    expect(dns.approveCalls).toBe(1); // the developer from the first attempt was kept
  });

  it('replaces a leftover key whose credential never got made instead of stacking keys', async () => {
    const first = await setupUser(deps, user);
    credentials.length = 0; // the n8n credential is gone (deleted, or the first run died after the key)
    await setupUser(deps, user);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.name).toBe(credentialName(first.handle));
    expect(activeKeys()).toHaveLength(1); // the old key was rotated out, not left beside the new one
    expect(keys.rows.size).toBe(2);
  });

  it('reports the failing step in plain terms when the Gateway cannot provision', async () => {
    dns.failApprove = true;
    const err = (await setupUser(deps, user).catch((e: unknown) => e)) as SetupError;
    expect(err).toBeInstanceOf(SetupError);
    expect(err.step).toBe('identity');
    expect(credentials).toHaveLength(0);
    expect(keys.rows.size).toBe(0);
  });

  it('refuses a wrong service token', async () => {
    const bad = createGatewayClient({ baseUrl: gatewayUrl, sessionSecret: SESSION_SECRET, serviceToken: 'x'.repeat(40) });
    await expect(bad.provision('u', 'Ada')).rejects.toMatchObject({ status: 401, code: 'AUTH_INVALID' });
  });

  it('answers a clear error when the Gateway is unreachable, without leaking the address', async () => {
    const down = createGatewayClient({ baseUrl: 'http://127.0.0.1:1', sessionSecret: SESSION_SECRET, serviceToken: SERVICE_TOKEN });
    const err = (await down.provision('u', 'Ada').catch((e: unknown) => e)) as GatewayError;
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.code).toBe('UNREACHABLE');
    expect(err.message).not.toContain('127.0.0.1');
  });
});

describe('Studio Session JWT', () => {
  it('is accepted by the Gateway and names the developer', () => {
    const now = Date.now();
    expect(verifySessionToken(mintSessionToken('zns:dev:abc', SESSION_SECRET, { nowMs: now }), SESSION_SECRET, now)).toBe('zns:dev:abc');
  });

  it('expires in about 5 minutes and is refused with another secret', () => {
    const now = Date.now();
    const token = mintSessionToken('zns:dev:abc', SESSION_SECRET, { nowMs: now });
    expect(() => verifySessionToken(token, SESSION_SECRET, now + 6 * 60_000)).toThrow(/expired/i);
    expect(() => verifySessionToken(token, 'another-secret-of-at-least-32-characters!!', now)).toThrow();
  });

  it('refuses a secret that is too short, and an empty developer', () => {
    expect(() => mintSessionToken('zns:dev:abc', 'short')).toThrow(/32/);
    expect(() => mintSessionToken('', SESSION_SECRET)).toThrow();
  });
});

describe('displayName', () => {
  it('prefers the Google name, then the email name, then a neutral one', () => {
    expect(displayName({ name: ' Ada Lovelace ', email: 'a@b.c' })).toBe('Ada Lovelace');
    expect(displayName({ name: '', email: 'ada.l@example.com' })).toBe('ada.l');
    expect(displayName({})).toBe('Zynd Studio user');
  });
});

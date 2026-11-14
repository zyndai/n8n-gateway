// DeveloperStore and the full provisioning flow against real Postgres (the dashboard's developer_keys table).
// Runs only with TEST_DATABASE_URL (migrations applied, developer_keys present).
import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDb, getDb } from '../src/db/client.js';
import { developerKey } from '../src/db/dashboard.js';
import { AgentDnsClient } from '../src/services/AgentDnsClient.js';
import { DeveloperStore, DuplicateDeveloperError } from '../src/services/DeveloperStore.js';
import { ProvisionService } from '../src/services/ProvisionService.js';
import { decryptSecret, parseMasterKey } from '../src/services/keyVault.js';
import { FakeAgentDns } from './helpers/fakeAgentDns.js';

const url = process.env.TEST_DATABASE_URL;
const PREFIX = `prov-${randomUUID().slice(0, 8)}`;
const masterKey = parseMasterKey('cd'.repeat(32));
const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!url)('provisioning on Postgres', () => {
  let store: DeveloperStore;
  const dev = (n: string) => ({ userId: `${PREFIX}-${n}`, developerId: `zns:dev:${PREFIX}-${n}`, name: `Dev ${n}`, publicKey: 'ed25519:AAAA', privateKeyEnc: 'enc' });

  beforeAll(() => {
    process.env.DATABASE_URL = url;
    store = new DeveloperStore(getDb());
  });

  afterAll(async () => {
    await getDb().delete(developerKey).where(like(developerKey.userId, `${PREFIX}%`));
    await disconnectDb();
  });

  it('inserts a developer without a handle and finds it by user', async () => {
    const row = await store.insert(dev('a'));
    expect(row).toMatchObject({ ...dev('a'), username: null });
    expect(await store.findByUserId(`${PREFIX}-a`)).toEqual(row);
    expect(await store.findByUserId(`${PREFIX}-missing`)).toBeUndefined();
  });

  it('refuses a second developer for the same user', async () => {
    await expect(store.insert({ ...dev('a'), developerId: `zns:dev:${PREFIX}-a2` })).rejects.toBeInstanceOf(DuplicateDeveloperError);
  });

  it('sets a handle once, keeps it unique, and never overwrites one', async () => {
    await store.insert(dev('b'));
    expect(await store.usernameTaken(`${PREFIX}-handle-b`)).toBe(false);
    expect(await store.setUsername(`${PREFIX}-b`, `${PREFIX}-handle-b`)).toBe('ok');
    expect(await store.usernameTaken(`${PREFIX}-handle-b`)).toBe(true);
    expect((await store.findByUserId(`${PREFIX}-b`))?.username).toBe(`${PREFIX}-handle-b`);

    expect(await store.setUsername(`${PREFIX}-b`, `${PREFIX}-other`)).toBe('already_set');
    expect((await store.findByUserId(`${PREFIX}-b`))?.username).toBe(`${PREFIX}-handle-b`);

    await store.insert(dev('c'));
    expect(await store.setUsername(`${PREFIX}-c`, `${PREFIX}-handle-b`)).toBe('taken');
    expect((await store.findByUserId(`${PREFIX}-c`))?.username).toBeNull();
  });

  it('provisions end to end: a new Google user gets a developer row and a verified handle; twice creates nothing new', async () => {
    const dns = new FakeAgentDns();
    await dns.listen();
    try {
      const svc = new ProvisionService({ directory: store, registry: new AgentDnsClient(dns.url), adminSecret: dns.adminSecret, masterKey, log: silent });
      const userId = `${PREFIX}-e2e`;
      const first = await svc.provision(userId, 'Ada Lovelace');
      expect(first.created).toBe(true);

      const [row] = await getDb().select().from(developerKey).where(eq(developerKey.userId, userId));
      expect(row).toMatchObject({ developerId: first.developerId, username: first.handle, name: 'Ada Lovelace', publicKey: dns.issuedKeys.get(first.developerId)?.publicKey });
      expect(decryptSecret(row!.privateKeyEnc, masterKey)).toBe(dns.issuedKeys.get(first.developerId)?.privateKeyB64);
      expect(dns.handles.get(first.handle)?.verified).toBe(true);

      const again = await svc.provision(userId, 'Ada Lovelace');
      expect(again).toEqual({ ...first, created: false });
      expect(dns.approveCalls).toBe(1);
      expect(await getDb().select().from(developerKey).where(eq(developerKey.userId, userId))).toHaveLength(1);

      // Two sign-ins at once, from two Gateway instances (no shared in-process lock): one developer row survives.
      const other = new ProvisionService({ directory: store, registry: new AgentDnsClient(dns.url), adminSecret: dns.adminSecret, masterKey, log: silent });
      const uid2 = `${PREFIX}-race`;
      const [x, y] = await Promise.all([svc.provision(uid2, 'Grace'), other.provision(uid2, 'Grace')]);
      expect(x.developerId).toBe(y.developerId);
      expect(x.handle).toBe(y.handle);
      expect(await getDb().select().from(developerKey).where(eq(developerKey.userId, uid2))).toHaveLength(1);
    } finally {
      await dns.close();
    }
  });
});

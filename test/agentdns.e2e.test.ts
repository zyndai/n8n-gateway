// M1.13 against a REAL AgentDNS node (staging, or a local `agentdns start`): register ->
// heartbeat -> shows as active in the registry and in search -> stop -> marked inactive.
//
// Opt-in; runs only when all of these are set:
//   TEST_DATABASE_URL        Postgres with the Gateway migrations + the dashboard's developer_keys
//   E2E_AGENTDNS_URL         e.g. http://127.0.0.1:8080
//   E2E_DEVELOPER_KEYPAIR    path to a developer.json (`agentdns dev-init`) whose developer is
//                            already registered on that node (`agentdns dev-register`)
// Optional:
//   E2E_INACTIVE_THRESHOLD_S the node's heartbeat.inactive_threshold_seconds. When set, the test
//                            proves liveness for real: the agent must STAY active past that
//                            threshold while we beat, then flip to inactive once we stop.
//                            (A freshly registered entity is already 'active', so a status check
//                            alone proves nothing.) 300 on defaults; use a small value locally.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { developerKey } from '../src/db/dashboard.js';
import { disconnectDb, getDb } from '../src/db/client.js';
import { n8nDerivationCounter, n8nHeartbeat, n8nListing } from '../src/db/schema.js';
import { AgentDnsClient } from '../src/services/AgentDnsClient.js';
import { HeartbeatManager } from '../src/services/HeartbeatManager.js';
import { IdentityService, keypairFromSeed, publicKeyString } from '../src/services/IdentityService.js';
import { ListingService } from '../src/services/ListingService.js';
import { ListingStore } from '../src/services/ListingStore.js';
import { encryptSecret, parseMasterKey } from '../src/services/keyVault.js';

const dbUrl = process.env.TEST_DATABASE_URL;
const dnsUrl = process.env.E2E_AGENTDNS_URL?.replace(/\/+$/, '');
const keyPath = process.env.E2E_DEVELOPER_KEYPAIR;
const thresholdS = Number(process.env.E2E_INACTIVE_THRESHOLD_S ?? 0);
const enabled = Boolean(dbUrl && dnsUrl && keyPath);

const silent = { info: () => {}, warn: () => {}, error: () => {} };

async function waitFor<T>(fn: () => Promise<T | undefined | false>, what: string, ms: number): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!enabled)('real AgentDNS (M1.13)', () => {
  const masterKey = parseMasterKey('ef'.repeat(32));
  let developerId = '';
  let devSeed: Uint8Array = new Uint8Array(32);
  let heartbeats: HeartbeatManager | undefined;

  interface RegistryEntity {
    entity_id?: string;
    developer_id?: string;
    entity_index?: number;
    public_key?: string;
    status?: string;
    registered_at: string;
    last_heartbeat: string;
  }
  const get = async (path: string) => (await fetch(`${dnsUrl}${path}`)).json() as Promise<RegistryEntity>;

  beforeAll(async () => {
    process.env.DATABASE_URL = dbUrl;
    const raw = JSON.parse(readFileSync(keyPath as string, 'utf8')) as { public_key: string; private_key: string };
    const priv = Buffer.from(raw.private_key, 'base64'); // Go: 64 bytes (seed || public); SDK: 32
    const pub = Buffer.from(raw.public_key, 'base64');
    devSeed = Uint8Array.from(priv.subarray(0, 32));
    developerId = `zns:dev:${bytesToHex(sha256(pub).slice(0, 16))}`;
    expect(publicKeyString(keypairFromSeed(Uint8Array.from(priv.subarray(0, 32))).publicKey)).toBe(`ed25519:${raw.public_key}`);

    const res = await fetch(`${dnsUrl}/v1/developers/${encodeURIComponent(developerId)}`);
    if (!res.ok) throw new Error(`developer ${developerId} is not registered on ${dnsUrl}; run \`agentdns dev-register\` first`);

    await getDb().insert(developerKey).values({
      id: randomUUID(),
      userId: `u_${developerId}`,
      developerId,
      publicKey: `ed25519:${raw.public_key}`,
      // Exactly what the dashboard stores: AES-256-GCM(base64(private key)).
      privateKeyEnc: encryptSecret(raw.private_key, masterKey),
      name: 'e2e',
    });
  });

  afterAll(async () => {
    heartbeats?.shutdown();
    const db = getDb();
    const rows = await db.select({ id: n8nListing.id }).from(n8nListing).where(eq(n8nListing.developerId, developerId));
    if (rows.length) await db.delete(n8nHeartbeat).where(inArray(n8nHeartbeat.listingId, rows.map((r) => r.id)));
    await db.delete(n8nListing).where(eq(n8nListing.developerId, developerId));
    await db.delete(n8nDerivationCounter).where(eq(n8nDerivationCounter.developerId, developerId));
    await db.delete(developerKey).where(eq(developerKey.developerId, developerId));
    await disconnectDb();
  });

  it('registers, heartbeats into the registry, appears active in search, then goes inactive', async () => {
    const store = new ListingStore(getDb());
    const identity = new IdentityService({ masterKey, keySource: store });
    const agentDns = new AgentDnsClient(dnsUrl as string);
    heartbeats = new HeartbeatManager({
      heartbeatUrl: (id) => agentDns.heartbeatUrl(id),
      identity, store, log: silent, intervalMs: 1000,
    });
    const listings = new ListingService({
      store, identity, agentDns, heartbeats,
      publicUrl: 'https://gw.example.test', heartbeatRequiresWebhook: true, log: silent,
    });

    const l = await listings.create(developerId, {
      name: `n8n-gateway-e2e-${Date.now()}`, summary: 'Gateway M1 e2e', category: 'general', tags: ['n8n', 'e2e'],
    });
    await getDb().update(n8nListing).set({ webhookUrl: 'https://n8n.example.test/hook' }).where(eq(n8nListing.id, l.id));

    // 1. Registration: the real node verifies our canonical-JSON signature and derivation proof.
    const active = await listings.activate(developerId, l.id);
    expect(active.status).toBe('ACTIVE');
    const entityId = active.entityId as string;
    const entityPath = `/v1/entities/${encodeURIComponent(entityId)}`;
    const entity = await get(entityPath);
    expect(entity.entity_id).toBe(entityId);
    expect(entity.developer_id).toBe(developerId);
    expect(entity.entity_index).toBe(l.derivedKeyIndex);
    expect(entity.public_key).toBe(publicKeyString(identity.deriveKeypair(devSeed, l.derivedKeyIndex).publicKey));

    // 2. Heartbeat: the node accepts our signed frames, so last_heartbeat keeps advancing.
    const t0 = Date.parse(entity.last_heartbeat ?? entity.registered_at);
    await waitFor(async () => Date.parse((await get(entityPath)).last_heartbeat) > t0 + 1000, 'last_heartbeat to advance', 15_000);
    await waitFor(
      async () => (await getDb().select().from(n8nHeartbeat).where(eq(n8nHeartbeat.listingId, l.id)))[0]?.lastBeatAt && true,
      'lastBeatAt in n8n_heartbeat', 5_000,
    );
    expect((await get(entityPath)).status).toBe('active');

    // 3. Visible in search.
    const search = await fetch(`${dnsUrl}/v1/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ developer_id: developerId, max_results: 50 }),
    });
    const found = ((await search.json()) as { results: { entity_id: string }[] }).results.find((r) => r.entity_id === entityId);
    expect(found, 'entity in search results').toBeDefined();

    if (thresholdS > 0) {
      // 3b. Real liveness: still active well past the inactivity threshold, because we keep beating.
      await new Promise((r) => setTimeout(r, (thresholdS + 4) * 1000));
      const live = await get(entityPath);
      expect(live.status, 'still active past the threshold while heartbeating').toBe('active');
      expect(Date.now() - Date.parse(live.last_heartbeat)).toBeLessThan(4000);
    }

    // 4. Stop: beats cease and the node marks the agent inactive after the threshold.
    await listings.deactivate(developerId, l.id);
    expect((await getDb().select().from(n8nHeartbeat).where(eq(n8nHeartbeat.listingId, l.id)))[0]?.status).toBe('STOPPED');
    if (thresholdS > 0) {
      await waitFor(async () => (await get(entityPath)).status === 'inactive', 'registry status=inactive', (thresholdS * 2 + 15) * 1000);
    }
  }, 600_000);
});

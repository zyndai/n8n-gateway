// /n8n/v1 routes: API key auth (M2.1), search (M2.3), listings (M2.4), webhook lifecycle (M2.5).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptSecret, parseMasterKey } from '../src/services/keyVault.js';
import { assertWebhookUrl } from '../src/services/webhookUrl.js';
import { API_KEY, DEV, makeGateway, type Gateway } from './helpers/harness.js';

let gw: Gateway;
afterEach(async () => {
  await gw?.close();
});

describe('apiKeyAuth (M2.1)', () => {
  it('rejects a missing or unknown key with AUTH_INVALID (401)', async () => {
    gw = await makeGateway();
    for (const key of [null, 'zk_not_a_real_key', '']) {
      const res = await gw.get('/n8n/v1/listings', key);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'AUTH_INVALID' });
    }
  });

  it('treats a revoked key exactly like an unknown one', async () => {
    gw = await makeGateway();
    gw.apiKeys.add('zk_revoked_key_000001', { developerId: DEV, revokedAt: new Date() });
    const res = await gw.get('/n8n/v1/listings', 'zk_revoked_key_000001');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_INVALID');
    expect(res.body.error).toBe((await gw.get('/n8n/v1/listings', 'zk_unknown')).body.error);
  });

  it('rejects an expired key with AUTH_EXPIRED (401)', async () => {
    gw = await makeGateway();
    gw.apiKeys.add('zk_expired_key_000001', { developerId: DEV, expiresAt: new Date(Date.now() - 1000) });
    const res = await gw.get('/n8n/v1/listings', 'zk_expired_key_000001');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_EXPIRED');
    gw.apiKeys.add('zk_future_key_0000001', { developerId: DEV, expiresAt: new Date(Date.now() + 60_000) });
    expect((await gw.get('/n8n/v1/listings', 'zk_future_key_0000001')).status).toBe(200);
  });

  it('enforces permissions per route with AUTH_FORBIDDEN (403)', async () => {
    gw = await makeGateway();
    gw.apiKeys.add('zk_search_only_000001', { developerId: DEV, permissions: ['search'] });
    const k = 'zk_search_only_000001';
    expect((await gw.get('/n8n/v1/agents?q=x', k)).status).toBe(200);
    for (const res of [await gw.get('/n8n/v1/listings', k), await gw.get('/n8n/v1/tasks/x', k), await gw.post('/n8n/v1/agents/x/tasks', { input: 1 }, k), await gw.get('/n8n/v1/webhooks', k)]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTH_FORBIDDEN');
    }
    gw.apiKeys.add('zk_none_000000000001', { developerId: DEV, permissions: [] });
    expect((await gw.get('/n8n/v1/agents?q=x', 'zk_none_000000000001')).status).toBe(403);
  });

  it('looks keys up by SHA-256 hash and updates lastUsedAt', async () => {
    gw = await makeGateway();
    expect(gw.keyRow.keyHash).toBe(bytesToHex(sha256(new TextEncoder().encode(API_KEY))));
    expect(gw.keyRow.keyHash).not.toContain(API_KEY);
    expect(gw.apiKeys.rows.get(gw.keyRow.id)?.lastUsedAt).toBeNull();
    await gw.get('/n8n/v1/listings');
    await new Promise((r) => setTimeout(r, 10));
    expect(gw.apiKeys.rows.get(gw.keyRow.id)?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('does not fail the request when the lastUsedAt write fails', async () => {
    gw = await makeGateway();
    gw.apiKeys.touch = async () => {
      throw new Error('db down');
    };
    expect((await gw.get('/n8n/v1/listings')).status).toBe(200);
  });
});

describe('GET /n8n/v1/agents (M2.3)', () => {
  it('maps the query to AgentDNS POST /v1/search and passes the answer through', async () => {
    gw = await makeGateway();
    gw.dns.searchResponse = { results: [{ entity_id: 'zns:a', name: 'A', summary: 's', category: 'c', tags: [], score: 0.9 }], total_found: 1, offset: 5, has_more: false };
    const res = await gw.get('/n8n/v1/agents?q=weather&category=general&limit=7&offset=5');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(gw.dns.searchResponse);
    expect(gw.dns.searchCalls).toEqual([{ query: 'weather', category: 'general', max_results: 7, offset: 5 }]);
  });

  it('uses defaults and validates paging', async () => {
    gw = await makeGateway();
    await gw.get('/n8n/v1/agents');
    expect(gw.dns.searchCalls[0]).toEqual({ query: '', max_results: 20, offset: 0 });
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'q=' + 'x'.repeat(201)]) {
      expect((await gw.get(`/n8n/v1/agents?${q}`)).status).toBe(400);
    }
  });

  it('reports an AgentDNS outage as 502 with the standard error shape', async () => {
    gw = await makeGateway();
    gw.dns.searchStatus = 503;
    const res = await gw.get('/n8n/v1/agents?q=x');
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
  });

  it('adds little overhead over calling AgentDNS directly (p99 < 50 ms)', async () => {
    gw = await makeGateway();
    const time = async (fn: () => Promise<unknown>) => {
      const t = performance.now();
      await fn();
      return performance.now() - t;
    };
    for (let i = 0; i < 20; i++) await gw.get('/n8n/v1/agents?q=w'); // warm up
    const overhead: number[] = [];
    for (let i = 0; i < 200; i++) {
      const direct = await time(() => fetch(`${gw.dns.url}/v1/search`, { method: 'POST', body: '{}' }));
      const viaGw = await time(() => gw.get('/n8n/v1/agents?q=w'));
      overhead.push(viaGw - direct);
    }
    overhead.sort((a, b) => a - b);
    expect(overhead[Math.floor(overhead.length * 0.99)]).toBeLessThan(50);
  });
});

describe('GET /n8n/v1/listings (M2.4)', () => {
  it('lists only the key\'s developer\'s listings', async () => {
    gw = await makeGateway();
    gw.store.keys.set('zns:dev:other', { privateKeyEnc: '', publicKey: '' });
    await gw.listings.create('zns:dev:other', { name: 'Theirs', summary: 's', category: 'c', tags: [] });
    await gw.listings.create(DEV, { name: 'Mine 2', summary: 's', category: 'c', tags: ['t'] });
    const res = await gw.get('/n8n/v1/listings');
    expect(res.status).toBe(200);
    expect(res.body.listings.map((l: { name: string }) => l.name).sort()).toEqual(['Mine 2', 'Weather']);
    expect(res.body.listings.find((l: { name: string }) => l.name === 'Weather')).toMatchObject({ status: 'ACTIVE', entityId: gw.entityId, entityUrl: `https://gw.test/a/${gw.entityId}`, webhookUrl: gw.webhookUrl });
    expect(JSON.stringify(res.body)).not.toMatch(/Secret|derivedKeyIndex/);
  });
});

describe('webhooks (M2.5, G14)', () => {
  const draft = () => gw.listings.create(DEV, { name: 'Fresh', summary: 's', category: 'c', tags: [] });

  it('POST binds the webhook, registers the DRAFT listing and starts the heartbeat', async () => {
    gw = await makeGateway();
    const l = await draft();
    const res = await gw.post('/n8n/v1/webhooks', { url: gw.webhookUrl, secret: 'a-long-secret', listingId: l.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: l.id, listingId: l.id, url: gw.webhookUrl, status: 'ACTIVE' });
    expect(res.body.entityId).toMatch(/^zns:/);
    expect(gw.dns.entities.has(res.body.entityId)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(gw.beats.started).toContain(res.body.entityId);
  });

  it('stores the secret encrypted, never in plaintext (G1), and does not echo it', async () => {
    gw = await makeGateway();
    const l = await draft();
    const res = await gw.post('/n8n/v1/webhooks', { url: gw.webhookUrl, secret: 'a-long-secret', listingId: l.id });
    expect(JSON.stringify(res.body)).not.toContain('a-long-secret');
    const stored = gw.store.listings.get(l.id)!.webhookSecretEnc as string;
    expect(stored).not.toContain('a-long-secret');
    expect(decryptSecret(stored, parseMasterKey('ab'.repeat(32)))).toBe('a-long-secret');
  });

  it('GET answers checkExists for an exact URL and lists bound webhooks', async () => {
    gw = await makeGateway();
    const hit = await gw.get(`/n8n/v1/webhooks?url=${encodeURIComponent(gw.webhookUrl)}`);
    expect(hit.body.webhooks).toHaveLength(1);
    expect(hit.body.webhooks[0]).toMatchObject({ id: gw.listing.id, url: gw.webhookUrl });
    expect((await gw.get(`/n8n/v1/webhooks?url=${encodeURIComponent(gw.webhookUrl + 'x')}`)).body.webhooks).toEqual([]);
    expect((await gw.get('/n8n/v1/webhooks')).body.webhooks).toHaveLength(1);
  });

  it('DELETE forgets the webhook, stops the heartbeat and stops inbound calls', async () => {
    gw = await makeGateway();
    const res = await gw.del(`/n8n/v1/webhooks/${gw.listing.id}`);
    expect(res.body).toEqual({ id: gw.listing.id, deleted: true });
    expect(gw.beats.stopped).toContain(gw.entityId);
    expect(gw.store.listings.get(gw.listing.id)).toMatchObject({ webhookUrl: null, webhookSecretEnc: null });
    expect((await gw.get(`/n8n/v1/webhooks?url=${encodeURIComponent(gw.webhookUrl)}`)).body.webhooks).toEqual([]);
    expect((await gw.send()).status).toBe(409);
  });

  it('re-binding replaces the URL and secret', async () => {
    gw = await makeGateway();
    await gw.post('/n8n/v1/webhooks', { url: 'http://127.0.0.1:9/new', secret: 'another-secret', listingId: gw.listing.id });
    const row = gw.store.listings.get(gw.listing.id)!;
    expect(row.webhookUrl).toBe('http://127.0.0.1:9/new');
    expect(decryptSecret(row.webhookSecretEnc as string, parseMasterKey('ab'.repeat(32)))).toBe('another-secret');
  });

  it('leaves a deliberately INACTIVE listing inactive', async () => {
    gw = await makeGateway();
    await gw.listings.deactivate(DEV, gw.listing.id);
    const res = await gw.post('/n8n/v1/webhooks', { url: gw.webhookUrl, secret: 'a-long-secret', listingId: gw.listing.id });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('INACTIVE');
  });

  it('validates input and ownership', async () => {
    gw = await makeGateway();
    const l = await draft();
    const body = (o: object) => ({ url: gw.webhookUrl, secret: 'a-long-secret', listingId: l.id, ...o });
    for (const bad of [{ url: 'ftp://x/y' }, { url: 'nope' }, { url: 'http://u:p@host/x' }, { secret: 'short' }, { secret: 12345678 }, { listingId: '' }]) {
      expect((await gw.post('/n8n/v1/webhooks', body(bad))).status).toBe(400);
    }
    expect((await gw.post('/n8n/v1/webhooks', body({ listingId: 'missing' }))).status).toBe(404);
    gw.apiKeys.add('zk_other_dev_key_00001', { developerId: 'zns:dev:other' });
    expect((await gw.post('/n8n/v1/webhooks', body({}), 'zk_other_dev_key_00001')).status).toBe(404);
    expect((await gw.del(`/n8n/v1/webhooks/${l.id}`, 'zk_other_dev_key_00001')).status).toBe(404);
    expect(gw.store.listings.get(l.id)?.webhookUrl).toBeNull();
  });
});

describe('webhook URL guard', () => {
  const prod = { allowPrivate: false };
  it('allows public https and, outside production, local http', () => {
    expect(assertWebhookUrl('https://n8n.example.com/webhook/x', prod)).toBe('https://n8n.example.com/webhook/x');
    expect(assertWebhookUrl('http://localhost:5678/webhook/x', { allowPrivate: true })).toBe('http://localhost:5678/webhook/x');
  });
  it('in production refuses http, loopback, private, link-local and internal names', () => {
    for (const u of ['http://example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://172.20.1.1/x', 'https://192.168.1.1/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://[::ffff:10.0.0.1]/x', 'https://[::ffff:7f00:1]/x', 'https://db.internal/x', 'https://box.local/x', 'https://a.localhost/x', 'https://0.0.0.0/x']) {
      expect(() => assertWebhookUrl(u, prod), u).toThrow();
    }
  });
  it('always refuses non-http schemes, credentials and absurd lengths', () => {
    for (const u of ['file:///etc/passwd', 'gopher://x', 'https://user:pw@example.com/', 'https://example.com/' + 'a'.repeat(2100)]) {
      expect(() => assertWebhookUrl(u, { allowPrivate: true }), u).toThrow();
    }
  });
});

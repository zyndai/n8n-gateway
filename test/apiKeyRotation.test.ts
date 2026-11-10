// M6.4: API key rotation with a grace period for the old key.
import { describe, expect, it } from 'vitest';
import { createApiKeyAuth } from '../src/middleware/apiKeyAuth.js';
import { ApiKeyService } from '../src/services/ApiKeyService.js';
import { MemoryApiKeys } from './helpers/memoryStores.js';

const DEV = 'zns:dev:alice';
const HOUR = 3_600_000;

function setup() {
  let t = new Date('2026-01-01T00:00:00Z');
  const store = new MemoryApiKeys();
  const svc = new ApiKeyService({ store, developerExists: async () => true, now: () => t });
  const auth = createApiKeyAuth(() => store, () => t);
  const status = async (key: string) => {
    try {
      await auth({ header: () => key } as never, {} as never, (() => undefined) as never);
      return 'OK';
    } catch (e) {
      return (e as { code?: string }).code ?? 'ERR';
    }
  };
  return { store, svc, status, advance: (ms: number) => void (t = new Date(t.getTime() + ms)) };
}

describe('ApiKeyService.rotate (M6.4)', () => {
  it('issues a copy and lets the old key work until the grace period ends', async () => {
    const { svc, status, advance } = setup();
    const old = await svc.create(DEV, { name: 'prod', permissions: ['search'], spendCapUsd: '5' });
    const { created, previous } = await svc.rotate(DEV, old.id, { graceHours: 2 });

    expect(created.id).not.toBe(old.id);
    expect(created.key).not.toBe(old.key);
    expect(created).toMatchObject({ name: 'prod', permissions: ['search'], spendCapUsd: '5', revokedAt: null });
    expect(previous.expiresAt?.toISOString()).toBe('2026-01-01T02:00:00.000Z');

    expect(await status(old.key)).toBe('OK');
    expect(await status(created.key)).toBe('OK');
    advance(2 * HOUR + 1);
    expect(await status(old.key)).toBe('AUTH_EXPIRED');
    expect(await status(created.key)).toBe('OK');
  });

  it('defaults to 24 hours and ends the old key at once with graceHours 0', async () => {
    const { svc, status } = setup();
    const a = await svc.create(DEV, { name: 'a' });
    const r1 = await svc.rotate(DEV, a.id, undefined);
    expect(r1.previous.expiresAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');

    const b = await svc.create(DEV, { name: 'b' });
    await svc.rotate(DEV, b.id, { graceHours: 0 });
    expect(await status(b.key)).toBe('AUTH_EXPIRED');
  });

  it('carries the spend so far, and never extends an earlier deadline', async () => {
    const { svc, store } = setup();
    const k = await svc.create(DEV, { name: 'k', spendCapUsd: '5', expiresAt: '2026-01-01T05:00:00Z' });
    await store.reserveSpend(k.id, 1_500_000n);
    const { created, previous } = await svc.rotate(DEV, k.id, { graceHours: 24 });
    expect(created.spentUsd).toBe('1.500000');
    expect(created.expiresAt?.toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(previous.expiresAt?.toISOString()).toBe('2026-01-01T05:00:00.000Z');
  });

  it('refuses unknown, foreign, revoked and expired keys, and bad grace values', async () => {
    const { svc, advance } = setup();
    const k = await svc.create(DEV, { name: 'k' });
    await expect(svc.rotate(DEV, 'nope', {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.rotate('zns:dev:bob', k.id, {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const g of [-1, 721, 'soon', null, NaN]) {
      await expect(svc.rotate(DEV, k.id, { graceHours: g }), String(g)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(svc.rotate(DEV, k.id, [])).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await svc.revoke(DEV, k.id);
    await expect(svc.rotate(DEV, k.id, {})).rejects.toMatchObject({ code: 'CONFLICT' });

    const e = await svc.create(DEV, { name: 'e', expiresAt: '2026-01-01T01:00:00Z' });
    advance(2 * HOUR);
    await expect(svc.rotate(DEV, e.id, {})).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

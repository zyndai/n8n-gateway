// M5.2 (G11): per-API-key token bucket on /n8n/v1/*.
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/services/RateLimiter.js';
import { DEV, makeGateway, type Gateway } from './helpers/harness.js';

let gw: Gateway;
afterEach(async () => {
  await gw?.close();
});

describe('RateLimiter', () => {
  const make = (perMinute: number, burst: number, extra = {}) => {
    let t = 1_000_000;
    const limiter = new RateLimiter({ perMinute, burst, now: () => t, ...extra });
    return { limiter, tick: (ms: number) => void (t += ms) };
  };

  it('lets a burst through, then refuses until tokens refill at perMinute/60 per second', () => {
    const { limiter, tick } = make(60, 3); // 1 token per second
    expect([1, 2, 3].map(() => limiter.take('k').allowed)).toEqual([true, true, true]);
    const refused = limiter.take('k');
    expect(refused).toMatchObject({ allowed: false, remaining: 0, retryAfterSec: 1, limit: 3 });
    tick(1000);
    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(false);
    tick(60_000);
    expect(limiter.take('k').remaining).toBe(2); // refill is capped at the burst
    expect(limiter.rejected).toBe(2);
  });

  it('keeps keys apart and reports how long to wait', () => {
    const { limiter } = make(6, 1); // 1 token per 10 s
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('b').allowed).toBe(true);
    expect(limiter.take('a')).toMatchObject({ allowed: false, retryAfterSec: 10 });
  });

  it('is off when perMinute is 0', () => {
    const { limiter } = make(0, 5);
    expect(limiter.enabled).toBe(false);
    for (let i = 0; i < 100; i++) expect(limiter.take('k').allowed).toBe(true);
  });

  it('forgets keys that have refilled and never grows past maxKeys', () => {
    const { limiter, tick } = make(60, 2, { maxKeys: 3 });
    limiter.take('a');
    limiter.take('b');
    expect(limiter.size).toBe(2);
    tick(5000);
    expect(limiter.prune()).toBe(2);
    expect(limiter.size).toBe(0);
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
      limiter.take(k);
      limiter.take(k); // leave every bucket partly drained so none is prunable
    }
    expect(limiter.size).toBeLessThanOrEqual(3);
  });
});

describe('/n8n/v1 rate limit', () => {
  it('answers 429 RATE_LIMITED with Retry-After once the bucket is empty, with limit headers before that', async () => {
    gw = await makeGateway({ rateLimit: { perMinute: 6, burst: 2 } });
    const first = await gw.get('/n8n/v1/listings');
    expect(first.status).toBe(200);
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');
    expect((await gw.get('/n8n/v1/listings')).status).toBe(200);

    const limited = await gw.get('/n8n/v1/listings');
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSec: 10 } });
    expect(limited.headers['retry-after']).toBe('10');
    expect(limited.headers['ratelimit-remaining']).toBe('0');
  });

  it('limits each key on its own', async () => {
    gw = await makeGateway({ rateLimit: { perMinute: 6, burst: 1 } });
    gw.apiKeys.add('zk_second_key_0002', { developerId: DEV });
    expect((await gw.get('/n8n/v1/listings')).status).toBe(200);
    expect((await gw.get('/n8n/v1/listings')).status).toBe(429);
    expect((await gw.get('/n8n/v1/listings', 'zk_second_key_0002')).status).toBe(200);
  });

  it('does not spend tokens on requests with a bad key, and does not limit when unconfigured', async () => {
    gw = await makeGateway({ rateLimit: { perMinute: 6, burst: 1 } });
    expect((await gw.get('/n8n/v1/listings', 'zk_nope')).status).toBe(401);
    expect((await gw.get('/n8n/v1/listings', 'zk_nope')).status).toBe(401);
    expect((await gw.get('/n8n/v1/listings')).status).toBe(200);
    await gw.close();

    gw = await makeGateway();
    for (let i = 0; i < 20; i++) expect((await gw.get('/n8n/v1/listings')).status).toBe(200);
  });

  it('does not touch the A2A endpoint or the agent card', async () => {
    gw = await makeGateway({ rateLimit: { perMinute: 6, burst: 1 } });
    for (let i = 0; i < 3; i++) expect((await request(gw.app).get(`/a/${gw.entityId}/.well-known/agent-card.json`)).status).toBe(200);
  });
});

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ERROR_CATALOGUE, ApiError, type ErrorCode } from '../src/errors.js';

const app = createApp();

describe('/health', () => {
  it('returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('error catalogue (LLD > Error Handling)', () => {
  const expected: Record<string, number> = {
    AUTH_INVALID: 401,
    AUTH_EXPIRED: 401,
    AUTH_FORBIDDEN: 403,
    PAYMENT_CAP: 402,
    NOT_FOUND: 404,
    LISTING_INACTIVE: 409,
    TASK_TIMEOUT: 504,
    PAYMENT_FAILED: 402,
  };

  for (const [code, status] of Object.entries(expected)) {
    it(`${code} maps to HTTP ${status}`, () => {
      expect(ERROR_CATALOGUE[code as ErrorCode].status).toBe(status);
      expect(new ApiError(code as ErrorCode).status).toBe(status);
    });
  }

  it('serialises as { error, code, details? }', () => {
    expect(new ApiError('NOT_FOUND').toBody()).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
    expect(new ApiError('BAD_REQUEST', 'nope', { field: 'q' }).toBody()).toEqual({
      error: 'nope',
      code: 'BAD_REQUEST',
      details: { field: 'q' },
    });
  });
});

describe('error middleware', () => {
  it('returns the error shape for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(typeof res.body.error).toBe('string');
  });

  it('returns 400 BAD_REQUEST for malformed JSON', async () => {
    const res = await request(app).post('/health').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('routes for each audience are mounted behind their auth', async () => {
    // n8n and A2A auth land in M2.1 / M2.6.
    for (const path of ['/n8n/v1/agents', '/a/ent_1/a2a/v1']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(501);
      expect(res.body.code).toBe('NOT_IMPLEMENTED');
    }
    // Dashboard routes demand a Session JWT (M1.8).
    const res = await request(createApp({ config: { sessionJwtSecret: 'x'.repeat(40) } })).get('/internal/v1/listings');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_INVALID');
  });
});

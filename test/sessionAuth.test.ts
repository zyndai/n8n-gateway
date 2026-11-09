import { describe, expect, it } from 'vitest';
import { verifySessionToken } from '../src/middleware/sessionAuth.js';
import { TEST_SECRET, inMinutes, mintToken } from './helpers/jwt.js';

const ok = { sub: 'zns:dev:abc', exp: inMinutes(5) };
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_ERROR';
};

describe('verifySessionToken (M1.8 / M4.3)', () => {
  it('returns the developer id for a valid token', () => {
    expect(verifySessionToken(mintToken(ok), TEST_SECRET)).toBe('zns:dev:abc');
  });
  it('rejects a bad signature, wrong secret, and tampered payload', () => {
    expect(code(() => verifySessionToken(mintToken(ok, { secret: 'x'.repeat(40) }), TEST_SECRET))).toBe('AUTH_INVALID');
    const [h, , s] = mintToken(ok).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'zns:dev:other', exp: ok.exp })).toString('base64url');
    expect(code(() => verifySessionToken(`${h}.${forged}.${s}`, TEST_SECRET))).toBe('AUTH_INVALID');
  });
  it('rejects alg=none and non-HS256 algorithms', () => {
    expect(code(() => verifySessionToken(mintToken(ok, { alg: 'none' }), TEST_SECRET))).toBe('AUTH_INVALID');
    expect(code(() => verifySessionToken(mintToken(ok, { alg: 'HS512' }), TEST_SECRET))).toBe('AUTH_INVALID');
  });
  it('rejects expired tokens (AUTH_EXPIRED), tokens without exp, and without sub', () => {
    expect(code(() => verifySessionToken(mintToken({ ...ok, exp: inMinutes(-5) }), TEST_SECRET))).toBe('AUTH_EXPIRED');
    expect(code(() => verifySessionToken(mintToken({ sub: 'zns:dev:abc' }), TEST_SECRET))).toBe('AUTH_INVALID');
    expect(code(() => verifySessionToken(mintToken({ exp: ok.exp }), TEST_SECRET))).toBe('AUTH_INVALID');
    expect(code(() => verifySessionToken(mintToken({ ...ok, sub: '' }), TEST_SECRET))).toBe('AUTH_INVALID');
  });
  it('honours nbf', () => {
    expect(code(() => verifySessionToken(mintToken({ ...ok, nbf: inMinutes(10) }), TEST_SECRET))).toBe('AUTH_INVALID');
  });
  it('rejects malformed tokens', () => {
    for (const t of ['', 'a.b', 'a.b.c.d', '...', 'not-a-jwt']) {
      expect(code(() => verifySessionToken(t, TEST_SECRET))).toBe('AUTH_INVALID');
    }
  });
});

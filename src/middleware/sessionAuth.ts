import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { ApiError } from '../errors.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by sessionAuth: the authenticated developer (`zns:dev:…`), from the JWT `sub`. */
    developerId?: string;
  }
}

const MIN_SECRET_LEN = 32;
const CLOCK_SKEW_S = 5;

const b64urlDecode = (s: string): Buffer => Buffer.from(s, 'base64url');

function parseJson(buf: Buffer): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verify an HS256 Session JWT minted by the dashboard server (G9 decision):
 *   header  { alg: 'HS256', typ: 'JWT' }
 *   payload { sub: <developerId>, exp: <unix seconds>, iat?, nbf? }
 * signed with the secret shared via SESSION_JWT_SECRET. `exp` is mandatory, so a leaked token
 * dies on its own; the dashboard should mint ~5 minute tokens per request.
 * Returns the developerId.
 */
export function verifySessionToken(token: string, secret: string, nowMs: number = Date.now()): string {
  const parts = token.split('.');
  const [h, p, s] = parts;
  if (parts.length !== 3 || !h || !p || !s) throw new ApiError('AUTH_INVALID', 'Invalid session token');

  const header = parseJson(b64urlDecode(h));
  // Pin the algorithm: never trust the header to pick one (rejects alg=none and RS/HS confusion).
  if (header?.alg !== 'HS256') throw new ApiError('AUTH_INVALID', 'Invalid session token');

  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = b64urlDecode(s);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ApiError('AUTH_INVALID', 'Invalid session token');
  }

  const claims = parseJson(b64urlDecode(p));
  const nowS = Math.floor(nowMs / 1000);
  if (!claims || typeof claims.sub !== 'string' || !claims.sub || typeof claims.exp !== 'number') {
    throw new ApiError('AUTH_INVALID', 'Invalid session token');
  }
  if (claims.exp + CLOCK_SKEW_S < nowS) throw new ApiError('AUTH_EXPIRED', 'Session token expired');
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > nowS) {
    throw new ApiError('AUTH_INVALID', 'Session token not yet valid');
  }
  return claims.sub;
}

/** Dashboard -> Gateway auth via Session JWT (M1.8). `getSecret` is lazy so the app boots without it. */
export function createSessionAuth(getSecret: () => string | undefined): RequestHandler {
  return (req, _res, next) => {
    const secret = getSecret();
    if (!secret || secret.length < MIN_SECRET_LEN) {
      // Server misconfiguration, not the caller's fault; say nothing specific.
      console.error(`SESSION_JWT_SECRET missing or shorter than ${MIN_SECRET_LEN} characters`);
      next(new ApiError('INTERNAL'));
      return;
    }
    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
    if (!match?.[1]) {
      next(new ApiError('AUTH_INVALID', 'Missing session token'));
      return;
    }
    try {
      req.developerId = verifySessionToken(match[1], secret);
      next();
    } catch (err) {
      next(err);
    }
  };
}

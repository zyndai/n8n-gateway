// n8n -> Gateway auth via `X-Zynd-Api-Key` (M2.1, HLD > Security Model). The key is SHA-256
// hashed (lower-case hex) and looked up; the plaintext is never stored.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { RequestHandler } from 'express';
import { ApiError } from '../errors.js';
import type { ApiKeyStoreLike } from '../services/ApiKeyStore.js';

export type Permission = 'search' | 'call' | 'complete';

export interface AuthedApiKey {
  id: string;
  developerId: string;
  permissions: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by apiKeyAuth. */
    apiKey?: AuthedApiKey;
  }
}

export const hashApiKey = (plaintext: string): string => bytesToHex(sha256(utf8ToBytes(plaintext)));

export function createApiKeyAuth(getStore: () => ApiKeyStoreLike, now: () => Date = () => new Date()): RequestHandler {
  return async (req, _res, next) => {
    const header = req.header('x-zynd-api-key');
    if (!header || header.length > 256) throw new ApiError('AUTH_INVALID');
    const store = getStore();
    const key = await store.findByHash(hashApiKey(header.trim()));
    // A revoked key looks exactly like an unknown one.
    if (!key || key.revokedAt) throw new ApiError('AUTH_INVALID');
    const at = now();
    if (key.expiresAt && key.expiresAt.getTime() <= at.getTime()) throw new ApiError('AUTH_EXPIRED');
    req.apiKey = { id: key.id, developerId: key.developerId, permissions: key.permissions };
    // Best effort: a failed bookkeeping write must not fail the request.
    void store.touch(key.id, at).catch(() => undefined);
    next();
  };
}

/** Route guard: the authenticated key must carry `permission`. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.apiKey) throw new ApiError('AUTH_INVALID');
    if (!req.apiKey.permissions.includes(permission)) {
      throw new ApiError('AUTH_FORBIDDEN', `API key lacks the "${permission}" permission`);
    }
    next();
  };
}

export function apiKeyOf(req: { apiKey?: AuthedApiKey }): AuthedApiKey {
  if (!req.apiKey) throw new ApiError('AUTH_INVALID');
  return req.apiKey;
}

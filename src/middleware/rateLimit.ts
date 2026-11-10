// M5.2: applies the per-key limiter after apiKeyAuth, so the bucket is the key's id.
import type { RequestHandler } from 'express';
import { ApiError } from '../errors.js';
import type { RateLimiter } from '../services/RateLimiter.js';

export function createRateLimit(getLimiter: () => RateLimiter | undefined): RequestHandler {
  return (req, res, next) => {
    const limiter = getLimiter();
    if (!limiter?.enabled) return next();
    if (!req.apiKey) throw new ApiError('AUTH_INVALID'); // wired after apiKeyAuth
    const d = limiter.take(req.apiKey.id);
    res.setHeader('RateLimit-Limit', String(d.limit));
    res.setHeader('RateLimit-Remaining', String(d.remaining));
    if (d.allowed) return next();
    res.setHeader('Retry-After', String(d.retryAfterSec));
    throw new ApiError('RATE_LIMITED', `Rate limit exceeded: retry in ${d.retryAfterSec} s`, { retryAfterSec: d.retryAfterSec });
  };
}

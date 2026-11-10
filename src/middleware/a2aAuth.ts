import type { RequestHandler } from 'express';
import type { NonceStoreLike } from '../services/NonceStore.js';
import { verifyZyndAuth, type A2AMessage, type VerifiedCaller } from '../services/zyndAuth.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by a2aAuth on message-carrying calls: the verified calling agent. */
    zyndCaller?: VerifiedCaller;
  }
}

/** JSON-RPC methods that carry a signed message (`tasks/get` and `tasks/cancel` carry only an id). */
export const SEND_METHODS = new Set(['tasks/send', 'message/send']);

/**
 * Agent -> Gateway auth (M2.6): verifies `x-zynd-auth` inside `params.message.metadata` of
 * message-carrying calls and claims its nonce. Failures reach the A2A router's error handler as
 * `ZyndAuthError` (401, JSON-RPC code -32100 / -32101 / -32102).
 */
export function createA2aAuth(getNonces: () => NonceStoreLike): RequestHandler {
  return async (req, _res, next) => {
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || typeof (body as { method?: unknown }).method !== 'string') return next();
    if (!SEND_METHODS.has((body as { method: string }).method)) return next();
    const message = (body as { params?: { message?: unknown } }).params?.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return next(); // the handler reports invalid params
    req.zyndCaller = await verifyZyndAuth(message as A2AMessage, getNonces());
    next();
  };
}

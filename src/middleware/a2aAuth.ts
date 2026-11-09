import type { RequestHandler } from 'express';
import { ApiError } from '../errors.js';

/** Agent -> Gateway auth via `x-zynd-auth` (JCS + domain tag + nonce). Implemented in M2.6. */
export const a2aAuth: RequestHandler = (_req, _res, next) => {
  next(new ApiError('NOT_IMPLEMENTED', 'a2aAuth lands in M2.6'));
};

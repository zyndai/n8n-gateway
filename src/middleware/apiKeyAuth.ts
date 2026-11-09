import type { RequestHandler } from 'express';
import { ApiError } from '../errors.js';

/** n8n -> Gateway auth via `X-Zynd-Api-Key`. Implemented in M2.1. */
export const apiKeyAuth: RequestHandler = (_req, _res, next) => {
  next(new ApiError('NOT_IMPLEMENTED', 'apiKeyAuth lands in M2.1'));
};

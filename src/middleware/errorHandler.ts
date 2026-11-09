import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ApiError } from '../errors.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new ApiError('NOT_FOUND', `Route not found: ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ApiError) {
    res.status(err.status).json(err.toBody());
    return;
  }
  // Malformed JSON bodies from express.json()
  if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json(new ApiError('BAD_REQUEST', 'Malformed JSON body').toBody());
    return;
  }
  // Never leak internals (stack traces, key material) to clients.
  console.error('Unhandled error', err);
  res.status(500).json(new ApiError('INTERNAL').toBody());
};

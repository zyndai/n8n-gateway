import { Router } from 'express';

export const healthRouter = Router();

// Liveness only: no dependency checks, so load balancers never flap on a DB blip.
healthRouter.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

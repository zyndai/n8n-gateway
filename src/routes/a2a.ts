import { Router } from 'express';
import { a2aAuth } from '../middleware/a2aAuth.js';

/** `/a/:entityId/a2a/v1` for other agents (A2A + x402). Lands in M2.9. */
export const a2aRouter = Router();
a2aRouter.use(a2aAuth);

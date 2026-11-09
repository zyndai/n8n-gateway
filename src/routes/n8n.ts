import { Router } from 'express';
import { apiKeyAuth } from '../middleware/apiKeyAuth.js';

/** `/n8n/v1/*` for the n8n nodes (API key). Routes land in M2.3-M2.15. */
export const n8nRouter = Router();
n8nRouter.use(apiKeyAuth);

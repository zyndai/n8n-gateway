import { Router, type Request } from 'express';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';
import { createSessionAuth } from '../middleware/sessionAuth.js';
import type { NewListing } from '../services/ListingStore.js';
import type { ListingService } from '../services/ListingService.js';

export interface DashboardDeps {
  config: Pick<Config, 'sessionJwtSecret'>;
  listings: () => ListingService;
}

function str(body: Record<string, unknown>, key: string, max: number, required = true): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) {
    if (required) throw new ApiError('BAD_REQUEST', `${key} is required`);
    return undefined;
  }
  if (typeof v !== 'string' || !v.trim() || v.length > max) {
    throw new ApiError('BAD_REQUEST', `${key} must be a non-empty string of at most ${max} characters`);
  }
  return v.trim();
}

export function parseNewListing(raw: unknown): NewListing {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError('BAD_REQUEST', 'Expected a JSON object');
  const body = raw as Record<string, unknown>;
  const tags = body.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 10 || tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 40)) {
    throw new ApiError('BAD_REQUEST', 'tags must be an array of at most 10 non-empty strings (40 characters max)');
  }
  const workflowId = str(body, 'workflowId', 100, false);
  return {
    name: str(body, 'name', 100) as string,
    summary: str(body, 'summary', 300) as string,
    category: str(body, 'category', 50) as string,
    tags: (tags as string[]).map((t) => t.trim()),
    ...(workflowId ? { workflowId } : {}),
  };
}

const developerOf = (req: Request): string => {
  if (!req.developerId) throw new ApiError('AUTH_INVALID', 'Invalid session token');
  return req.developerId;
};

/**
 * Internal routes for the dashboard (G9 decision), mounted at `/internal/v1`. The dashboard's
 * server routes (`/api/n8n/listings…`) call these with a Session JWT; every route is scoped to
 * the JWT's developer and answers 404 for anything that developer does not own.
 */
export function createDashboardRouter(deps: DashboardDeps): Router {
  const router = Router();
  router.use(createSessionAuth(() => deps.config.sessionJwtSecret));

  router.post('/listings', async (req, res) => {
    const listing = await deps.listings().create(developerOf(req), parseNewListing(req.body));
    res.status(201).json(listing);
  });

  router.get('/listings', async (req, res) => {
    res.json({ listings: await deps.listings().list(developerOf(req)) });
  });

  router.get('/listings/:id', async (req, res) => {
    res.json(await deps.listings().get(developerOf(req), req.params.id as string));
  });

  // M1.8: one-click activation = register on AgentDNS (+ heartbeat once a webhook is bound).
  router.post('/listings/:id/activate', async (req, res) => {
    res.json(await deps.listings().activate(developerOf(req), req.params.id as string));
  });

  router.post('/listings/:id/deactivate', async (req, res) => {
    res.json(await deps.listings().deactivate(developerOf(req), req.params.id as string));
  });

  return router;
}

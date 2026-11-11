import { Router, type Request } from 'express';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';
import { createSessionAuth } from '../middleware/sessionAuth.js';
import type { ApiKeyService } from '../services/ApiKeyService.js';
import type { NewListing } from '../services/ListingStore.js';
import type { ListingService, ListingUpdate } from '../services/ListingService.js';
import { summarizeAnalytics } from '../services/analytics.js';
import type { TaskRow, TaskStoreLike } from '../services/TaskStore.js';
import type { WalletService } from '../services/WalletService.js';

export interface DashboardDeps {
  config: Pick<Config, 'sessionJwtSecret'>;
  listings: () => ListingService;
  apiKeys: () => ApiKeyService;
  tasks: () => Pick<TaskStoreLike, 'listByDeveloper' | 'analytics'>;
  wallet: () => WalletService;
}

/** M4.9: task history rows. Payloads (`input`, `output`) stay in the Gateway; the table only needs metadata. */
export interface TaskHistoryItem {
  id: string;
  listingId: string | null;
  direction: TaskRow['direction'];
  callerId: string | null;
  status: TaskRow['status'];
  paymentUsd: string | null;
  paymentTxn: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const taskItem = (t: TaskRow): TaskHistoryItem => ({
  id: t.id,
  listingId: t.listingId,
  direction: t.direction,
  callerId: t.callerId,
  status: t.status,
  paymentUsd: t.paymentUsd,
  paymentTxn: t.paymentTxn,
  error: t.error,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

function queryInt(raw: unknown, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError('BAD_REQUEST', `${name} must be an integer between ${min} and ${max}`);
  return n;
}

/** AgentDNS rejects registration with 400 "summary must be 200 characters or less". */
export const SUMMARY_MAX = 200;

/** PATCH body: any of name, summary, tags, workflowId (null clears it) and priceUsd (null = Gateway default). */
export function parseListingUpdate(raw: unknown): ListingUpdate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError('BAD_REQUEST', 'Expected a JSON object');
  const body = raw as Record<string, unknown>;
  const out: ListingUpdate = {};
  if ('name' in body) out.name = str(body, 'name', 100) as string;
  if ('summary' in body) out.summary = str(body, 'summary', SUMMARY_MAX) as string;
  if ('tags' in body) out.tags = parseTags(body.tags);
  if ('workflowId' in body) out.workflowId = body.workflowId === null ? null : (str(body, 'workflowId', 100) as string);
  if ('priceUsd' in body) out.priceUsd = parsePrice(body.priceUsd);
  if (Object.keys(out).length === 0) throw new ApiError('BAD_REQUEST', 'Send at least one of name, summary, tags, workflowId, priceUsd');
  return out;
}

function parseTags(tags: unknown): string[] {
  if (!Array.isArray(tags) || tags.length > 10 || tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 40)) {
    throw new ApiError('BAD_REQUEST', 'tags must be an array of at most 10 non-empty strings (40 characters max)');
  }
  return (tags as string[]).map((t) => t.trim());
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
  const tags = parseTags(body.tags ?? []);
  const workflowId = str(body, 'workflowId', 100, false);
  const price = body.priceUsd === undefined ? undefined : parsePrice(body.priceUsd);
  if (price === null) throw new ApiError('BAD_REQUEST', 'priceUsd must be a USD amount');
  return {
    name: str(body, 'name', 100) as string,
    summary: str(body, 'summary', SUMMARY_MAX) as string,
    category: str(body, 'category', 50) as string,
    tags,
    ...(workflowId ? { workflowId } : {}),
    ...(price !== undefined ? { priceUsd: price } : {}),
  };
}

function parsePrice(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') throw new ApiError('BAD_REQUEST', 'priceUsd must be a USD amount or null');
  return String(v);
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

  // M4.1 / G17: edit name, summary, tags, workflowId and price (`"0.05"`, "0" for free, null for the Gateway default).
  router.patch('/listings/:id', async (req, res) => {
    res.json(await deps.listings().update(developerOf(req), req.params.id as string, parseListingUpdate(req.body)));
  });

  // M4.1: stop the heartbeat and delete.
  router.delete('/listings/:id', async (req, res) => {
    res.json(await deps.listings().remove(developerOf(req), req.params.id as string));
  });

  // M1.8: one-click activation = register on AgentDNS (+ heartbeat once a webhook is bound).
  router.post('/listings/:id/activate', async (req, res) => {
    res.json(await deps.listings().activate(developerOf(req), req.params.id as string));
  });

  router.post('/listings/:id/deactivate', async (req, res) => {
    res.json(await deps.listings().deactivate(developerOf(req), req.params.id as string));
  });

  // M4.2: API keys. The plaintext is in the POST response only.
  router.post('/api-keys', async (req, res) => {
    res.status(201).json(await deps.apiKeys().create(developerOf(req), req.body));
  });

  router.get('/api-keys', async (req, res) => {
    res.json({ keys: await deps.apiKeys().list(developerOf(req)) });
  });

  // M6.4: issue a replacement and let the old key expire after `graceHours` (default 24, 0 = now).
  router.post('/api-keys/:id/rotate', async (req, res) => {
    const out = await deps.apiKeys().rotate(developerOf(req), req.params.id as string, req.body);
    res.status(201).json({ ...out.created, previous: out.previous });
  });

  router.delete('/api-keys/:id', async (req, res) => {
    res.json(await deps.apiKeys().revoke(developerOf(req), req.params.id as string));
  });

  // M4.9: task history, newest first. ?listingId&direction=INBOUND|OUTBOUND&limit(1-100)&offset
  router.get('/tasks', async (req, res) => {
    const dir = req.query.direction;
    if (dir !== undefined && dir !== '' && dir !== 'INBOUND' && dir !== 'OUTBOUND') throw new ApiError('BAD_REQUEST', 'direction must be INBOUND or OUTBOUND');
    const listingId = req.query.listingId;
    if (listingId !== undefined && (typeof listingId !== 'string' || listingId.length > 100)) throw new ApiError('BAD_REQUEST', 'listingId must be a string');
    const rows = await deps.tasks().listByDeveloper(developerOf(req), {
      ...(listingId ? { listingId } : {}),
      ...(dir ? { direction: dir } : {}),
      limit: queryInt(req.query.limit, 'limit', 25, 1, 100),
      offset: queryInt(req.query.offset, 'offset', 0, 0, 100_000),
    });
    res.json({ tasks: rows.map(taskItem) });
  });

  // M6.2: listing analytics. ?days(1-365, default 30)&listingId. Inbound calls only, UTC days.
  router.get('/analytics', async (req, res) => {
    const listingId = req.query.listingId;
    if (listingId !== undefined && (typeof listingId !== 'string' || listingId.length > 100)) throw new ApiError('BAD_REQUEST', 'listingId must be a string');
    const days = queryInt(req.query.days, 'days', 30, 1, 365);
    const now = new Date();
    // Start of the UTC day (days - 1) days ago, so `days` full calendar days including today.
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
    const series = await deps.tasks().analytics(developerOf(req), { since, ...(listingId ? { listingId } : {}) });
    res.json({ days, since: since.toISOString(), ...summarizeAnalytics(series) });
  });

  // M4.10: public EVM addresses only.
  router.get('/wallet', async (req, res) => {
    res.json(await deps.wallet().forDeveloper(developerOf(req)));
  });

  return router;
}

// `/n8n/v1/*` for the n8n nodes (API key). Contract: src/n8nContract.ts, docs/N8N_API.md.
import { Router, type Request } from 'express';
import { ApiError } from '../errors.js';
import { apiKeyOf, createApiKeyAuth, requirePermission } from '../middleware/apiKeyAuth.js';
import type {
  BindWebhookRequest,
  CompleteJobResponse,
  ListListingsResponse,
  ListWebhooksResponse,
  ListingSummary,
  UnbindWebhookResponse,
  WebhookView,
} from '../n8nContract.js';
import type { A2AHandler } from '../services/A2AHandler.js';
import type { AgentCaller } from '../services/AgentCaller.js';
import type { AgentDnsClient } from '../services/AgentDnsClient.js';
import { toGatewayError } from '../services/AgentDnsClient.js';
import type { ApiKeyStoreLike } from '../services/ApiKeyStore.js';
import type { ListingService, ListingView } from '../services/ListingService.js';

export interface N8nDeps {
  apiKeys: () => ApiKeyStoreLike;
  agentDns: () => Pick<AgentDnsClient, 'search'>;
  listings: () => ListingService;
  caller: () => AgentCaller;
  a2a: () => A2AHandler;
}

const developerOf = (req: Request): string => apiKeyOf(req).developerId;
const param = (req: Request, name: string): string => req.params[name] as string;

function obj(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError('BAD_REQUEST', 'Expected a JSON object');
  return raw as Record<string, unknown>;
}

function queryString(req: Request, name: string, max: number): string | undefined {
  const v = req.query[name];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw new ApiError('BAD_REQUEST', `${name} must be a string of at most ${max} characters`);
  return v;
}

function queryInt(req: Request, name: string, fallback: number, min: number, max: number): number {
  const v = req.query[name];
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError('BAD_REQUEST', `${name} must be an integer between ${min} and ${max}`);
  return n;
}

const summary = (l: ListingView): ListingSummary => ({
  id: l.id,
  name: l.name,
  summary: l.summary,
  category: l.category,
  tags: l.tags,
  entityId: l.entityId,
  entityUrl: l.entityUrl,
  webhookUrl: l.webhookUrl,
  status: l.status,
});

const webhook = (l: ListingView): WebhookView => ({ id: l.id, listingId: l.id, url: l.webhookUrl, entityId: l.entityId, status: l.status });

export function createN8nRouter(deps: N8nDeps): Router {
  const router = Router();
  router.use(createApiKeyAuth(() => deps.apiKeys()));

  // M2.3: search proxied to AgentDNS.
  router.get('/agents', requirePermission('search'), async (req, res) => {
    const query = queryString(req, 'q', 200) ?? '';
    const category = queryString(req, 'category', 50);
    const body = { query, ...(category ? { category } : {}), max_results: queryInt(req, 'limit', 20, 1, 100), offset: queryInt(req, 'offset', 0, 0, 10_000) };
    try {
      res.json(await deps.agentDns().search(body));
    } catch (err) {
      throw toGatewayError(err);
    }
  });

  // M2.14: call an agent (blocks until the remote task is terminal).
  router.post('/agents/:id/tasks', requirePermission('call'), async (req, res) => {
    const body = obj(req.body);
    if (!('input' in body)) throw new ApiError('BAD_REQUEST', 'input is required');
    res.json(await deps.caller().call(apiKeyOf(req), param(req, 'id'), { input: body.input, maxPaymentUsd: body.maxPaymentUsd as string | number | undefined }));
  });

  // M2.15
  router.get('/tasks/:id', requirePermission('call'), async (req, res) => {
    res.json(await deps.caller().getTask(apiKeyOf(req), param(req, 'id')));
  });

  // M2.11: the workflow reports a result for an inbound job.
  router.post('/jobs/:id/complete', requirePermission('complete'), async (req, res) => {
    const body = obj(req.body);
    let result: { output: unknown } | { error: string };
    if (typeof body.error === 'string' && body.error) result = { error: body.error.slice(0, 2000) };
    else if ('output' in body) result = { output: body.output };
    else throw new ApiError('BAD_REQUEST', 'Send either output or error');
    const task = await deps.a2a().completeJob(developerOf(req), param(req, 'id'), result);
    const out: CompleteJobResponse = { jobId: task.id, status: task.status.state === 'completed' ? 'COMPLETED' : 'FAILED' };
    res.json(out);
  });

  // M2.4
  router.get('/listings', requirePermission('complete'), async (req, res) => {
    const out: ListListingsResponse = { listings: (await deps.listings().list(developerOf(req))).map(summary) };
    res.json(out);
  });

  // M2.5: webhook lifecycle (G14: the webhook id is the listing id).
  router.get('/webhooks', requirePermission('complete'), async (req, res) => {
    const url = queryString(req, 'url', 2048);
    const rows = url ? await deps.listings().findWebhooks(developerOf(req), url) : (await deps.listings().list(developerOf(req))).filter((l) => l.webhookUrl);
    const out: ListWebhooksResponse = { webhooks: rows.map(webhook) };
    res.json(out);
  });

  router.post('/webhooks', requirePermission('complete'), async (req, res) => {
    const body = obj(req.body) as Partial<BindWebhookRequest>;
    if (typeof body.listingId !== 'string' || !body.listingId) throw new ApiError('BAD_REQUEST', 'listingId is required');
    const view = await deps.listings().bindWebhook(developerOf(req), body.listingId, { url: body.url, secret: body.secret });
    res.status(201).json(webhook(view));
  });

  router.delete('/webhooks/:id', requirePermission('complete'), async (req, res) => {
    const view = await deps.listings().unbindWebhook(developerOf(req), param(req, 'id'));
    const out: UnbindWebhookResponse = { id: view.id, deleted: true };
    res.json(out);
  });

  return router;
}

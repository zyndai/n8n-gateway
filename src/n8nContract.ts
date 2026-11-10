/**
 * The frozen `/n8n/v1/*` contract (M2.2). `n8n-nodes-zynd` (M3) and the dashboard (M4) build
 * against these types; the routes in `routes/n8n.ts` return exactly these shapes. Changing a
 * field here is a breaking change: add a new field, do not repurpose one. Prose version with
 * permissions and examples: docs/N8N_API.md.
 *
 * Auth: every route needs `X-Zynd-Api-Key`. Permission per route is in the comments below.
 * Errors: any non-2xx body is `{ error, code, details? }` (see errors.ts).
 */

/** GET /agents?q&category&limit&offset  (permission: search). Passed through from AgentDNS POST /v1/search. */
export interface SearchAgentsResponse {
  results: {
    entity_id: string;
    name: string;
    summary: string;
    category: string;
    tags: string[];
    status?: string;
    score: number;
    [k: string]: unknown;
  }[];
  total_found: number;
  offset: number;
  has_more: boolean;
}

/** POST /agents/:entityId/tasks  (permission: call). Blocks until the remote task is terminal (300 s cap). */
export interface CallAgentRequest {
  /** String -> text part; anything else -> data part. */
  input: unknown;
  /** USD ceiling for this call. Defaults to X402_DEFAULT_MAX_PAYMENT_USD. 6 decimals max. */
  maxPaymentUsd?: string | number;
}

/** Response of POST /agents/:id/tasks and GET /tasks/:id  (permission: call). */
export interface TaskResult {
  taskId: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'TIMEOUT' | 'CANCELED';
  output: unknown;
  error: string | null;
  /** USD actually reserved for the call, e.g. "0.050000". */
  paymentUsd: string | null;
  paymentTxn: string | null;
}

/** POST /jobs/:id/complete  (permission: complete). Send `output` (success) or `error` (failure). */
export type CompleteJobRequest = { output: unknown } | { error: string };
export interface CompleteJobResponse {
  jobId: string;
  status: 'COMPLETED' | 'FAILED';
}

/** GET /listings  (permission: complete). Only the key's developer's listings. */
export interface ListingSummary {
  id: string;
  name: string;
  summary: string;
  category: string;
  tags: string[];
  entityId: string | null;
  entityUrl: string | null;
  webhookUrl: string | null;
  status: 'DRAFT' | 'REGISTERING' | 'ACTIVE' | 'INACTIVE' | 'ERROR';
}
export interface ListListingsResponse {
  listings: ListingSummary[];
}

/** A webhook is identified by its listing (G14): `id === listingId`. */
export interface WebhookView {
  id: string;
  listingId: string;
  url: string | null;
  entityId: string | null;
  status: ListingSummary['status'];
}
/** GET /webhooks[?url=]  (permission: complete). `url` filters to exact matches (checkExists). */
export interface ListWebhooksResponse {
  webhooks: WebhookView[];
}
/** POST /webhooks  (permission: complete). Binds the URL, registers the listing if needed, starts the heartbeat. */
export interface BindWebhookRequest {
  url: string;
  /** 8-256 chars. Sent back to the workflow in `X-Zynd-Webhook-Secret`. */
  secret: string;
  listingId: string;
}
/** DELETE /webhooks/:id  (permission: complete). */
export interface UnbindWebhookResponse {
  id: string;
  deleted: true;
}

/**
 * Body the Gateway POSTs to the workflow's webhook (header `X-Zynd-Webhook-Secret`, `X-Zynd-Job-Id`).
 * The workflow answers either:
 *  - immediately with 2xx and a JSON body containing `output` (synchronous, `responseMode = lastNode`), or
 *  - with any other 2xx and later calls POST /jobs/:jobId/complete.
 */
export interface WebhookJob {
  jobId: string;
  listingId: string;
  entityId: string;
  caller: string;
  input: unknown;
  message: unknown;
  createdAt: string;
}

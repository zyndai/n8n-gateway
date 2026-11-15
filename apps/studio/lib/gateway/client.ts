// Studio's server talks to the Gateway two ways (docs/LLD.md): `provision` with the service token, and everything
// else with a short Session JWT for one developer. The developer id always comes from Studio's own checked
// session, never from a request, so one user cannot name another.
import { mintSessionToken } from './token';

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The Gateway's error code (`NOT_FOUND`, `GATEWAY_UNAVAILABLE`…), or `UNREACHABLE`. */
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface ProvisionedDeveloper {
  developerId: string;
  handle: string;
  name: string;
  created: boolean;
}

export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  spendCapUsd: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreatedApiKey extends ApiKeyView {
  /** The plaintext, shown once. */
  key: string;
}

export interface ListingView {
  id: string;
  name: string;
  summary: string;
  category: string;
  tags: string[];
  entityId: string | null;
  workflowId: string | null;
  priceUsd: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface WalletView {
  payer: string;
  payerBalanceUsd: string | null;
  listings: { listingId: string; name: string; address: string; balanceUsd: string | null }[];
}

export interface NewListingBody {
  name: string;
  summary: string;
  category: string;
  tags: string[];
  workflowId?: string;
  priceUsd?: string;
}

export interface ListingPatch {
  name?: string;
  summary?: string;
  tags?: string[];
  /** `null` clears it. */
  workflowId?: string | null;
  /** `"0"` for free, `null` for the Gateway default. */
  priceUsd?: string | null;
}

export interface TaskView {
  id: string;
  listingId: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  callerId: string | null;
  status: string;
  paymentUsd: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListingTotals {
  listingId: string | null;
  calls: number;
  completed: number;
  failed: number;
  errorRate: number | null;
  /** Settled payments of completed inbound calls, a decimal string. */
  revenueUsd: string;
}

export interface GatewayConfig {
  baseUrl: string;
  sessionSecret: string;
  serviceToken: string;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function send<T>(fetchImpl: typeof fetch, url: string, method: Method, token: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new GatewayError('The Gateway could not be reached', 502, 'UNREACHABLE');
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // A proxy or crash page: never pass its HTML on.
    throw new GatewayError('Unexpected response from the Gateway', res.status >= 500 ? 502 : res.status, 'UNEXPECTED');
  }
  if (!res.ok) {
    const e = (parsed ?? {}) as { error?: string; code?: string; details?: unknown };
    throw new GatewayError(e.error ?? `Gateway answered ${res.status}`, res.status, e.code ?? 'UNKNOWN', e.details);
  }
  return parsed as T;
}

export interface DeveloperApi {
  listListings(): Promise<ListingView[]>;
  getListing(id: string): Promise<ListingView>;
  createListing(body: NewListingBody): Promise<ListingView>;
  updateListing(id: string, patch: ListingPatch): Promise<ListingView>;
  deleteListing(id: string): Promise<unknown>;
  /** Registers the listing on the network (or turns a paused one back on) and starts its heartbeat. Idempotent. */
  activateListing(id: string): Promise<ListingView>;
  /** Live -> paused: stops the heartbeat. Only for a listing that has been live. */
  deactivateListing(id: string): Promise<ListingView>;
  /** Tasks of this developer, newest first (metadata only: never input or output). */
  listTasks(query: { listingId?: string; direction?: 'INBOUND' | 'OUTBOUND'; limit?: number }): Promise<TaskView[]>;
  /** Per-listing totals over the last `days` days (inbound calls only). */
  analytics(query: { days?: number; listingId?: string }): Promise<ListingTotals[]>;
  listApiKeys(): Promise<ApiKeyView[]>;
  createApiKey(body: { name: string; permissions?: string[]; spendCapUsd?: string }): Promise<CreatedApiKey>;
  rotateApiKey(id: string, body: { graceHours: number }): Promise<CreatedApiKey>;
  revokeApiKey(id: string): Promise<unknown>;
  wallet(): Promise<WalletView>;
}

export interface GatewayClient {
  provision(userId: string, name: string): Promise<ProvisionedDeveloper>;
  /** Calls scoped to one developer, with a fresh Session JWT per request. */
  as(developerId: string): DeveloperApi;
}

export function createGatewayClient(cfg: GatewayConfig, fetchImpl: typeof fetch = fetch): GatewayClient {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  return {
    provision: (userId, name) => send(fetchImpl, `${base}/internal/v1/provision`, 'POST', cfg.serviceToken, { userId, name }),
    as(developerId) {
      const call = <T>(method: Method, path: string, body?: unknown) =>
        send<T>(fetchImpl, `${base}/internal/v1${path}`, method, mintSessionToken(developerId, cfg.sessionSecret), body);
      return {
        listListings: async () => (await call<{ listings: ListingView[] }>('GET', '/listings')).listings,
        getListing: (id) => call('GET', `/listings/${encodeURIComponent(id)}`),
        createListing: (body) => call('POST', '/listings', body),
        updateListing: (id, patch) => call('PATCH', `/listings/${encodeURIComponent(id)}`, patch),
        deleteListing: (id) => call('DELETE', `/listings/${encodeURIComponent(id)}`),
        activateListing: (id) => call('POST', `/listings/${encodeURIComponent(id)}/activate`),
        deactivateListing: (id) => call('POST', `/listings/${encodeURIComponent(id)}/deactivate`),
        listTasks: async (q) => {
          const qs = new URLSearchParams();
          if (q.listingId) qs.set('listingId', q.listingId);
          if (q.direction) qs.set('direction', q.direction);
          qs.set('limit', String(q.limit ?? 25));
          return (await call<{ tasks: TaskView[] }>('GET', `/tasks?${qs}`)).tasks;
        },
        analytics: async (q) => {
          const qs = new URLSearchParams({ days: String(q.days ?? 30) });
          if (q.listingId) qs.set('listingId', q.listingId);
          return (await call<{ totals: ListingTotals[] }>('GET', `/analytics?${qs}`)).totals;
        },
        listApiKeys: async () => (await call<{ keys: ApiKeyView[] }>('GET', '/api-keys')).keys,
        createApiKey: (body) => call('POST', '/api-keys', body),
        rotateApiKey: (id, body) => call('POST', `/api-keys/${encodeURIComponent(id)}/rotate`, body),
        revokeApiKey: (id) => call('DELETE', `/api-keys/${encodeURIComponent(id)}`),
        wallet: () => call('GET', '/wallet'),
      };
    },
  };
}

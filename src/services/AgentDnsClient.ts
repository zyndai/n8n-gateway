import { ApiError } from '../errors.js';
import type { DerivationProof } from './IdentityService.js';

export interface RegisterEntityBody {
  category: string;
  entity_url: string;
  name: string;
  public_key: string;
  signature: string;
  summary: string;
  tags: string[];
  developer_id: string;
  developer_proof: DerivationProof;
}

export class AgentDnsError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'AgentDnsError';
  }
}

export interface EntityRecord {
  entity_id?: string;
  public_key?: string;
  status?: string;
  entity_url?: string;
  name?: string;
}

/** What the registry returns when an admin approves a developer: the key is encrypted under SHA-256(state). */
export interface DeveloperApproval {
  developer_id: string;
  private_key_enc: string;
  public_key: string;
}

export interface HandleClaim {
  handle: string;
  developer_id: string;
  public_key: string;
  /** `ed25519:<base64>` over the canonical JSON of { developer_id, handle, public_key }. */
  signature: string;
}

export interface SearchQuery {
  query: string;
  category?: string;
  max_results: number;
  offset: number;
}

const TIMEOUT_MS = 10_000;

/** Thin AgentDNS HTTP client (M0.11 shapes: POST /v1/entities, GET /v1/entities/{id}, WS /v1/entities/{id}/ws). */
export class AgentDnsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** `wss://` / `ws://` URL of an entity's heartbeat socket. */
  heartbeatUrl(entityId: string): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/v1/entities/${encodeURIComponent(entityId)}/ws`;
  }

  /** POST /v1/entities. Returns the registry-assigned entity id. 409 surfaces as `AgentDnsError(status 409)`. */
  async registerEntity(body: RegisterEntityBody): Promise<string> {
    const res = await this.request('POST', '/v1/entities', body);
    const data = (await res.json().catch(() => ({}))) as { entity_id?: string };
    if (!data.entity_id) throw new AgentDnsError('AgentDNS response had no entity_id', res.status);
    return data.entity_id;
  }

  /** GET /v1/entities/{id}; null on 404. */
  async getEntity(entityId: string): Promise<EntityRecord | null> {
    try {
      const res = await this.request('GET', `/v1/entities/${encodeURIComponent(entityId)}`);
      return (await res.json()) as EntityRecord;
    } catch (err) {
      if (err instanceof AgentDnsError && err.status === 404) return null;
      throw err;
    }
  }

  /** POST /v1/search (M2.3). The registry's response is passed through unchanged. */
  async search(body: SearchQuery): Promise<unknown> {
    const res = await this.request('POST', '/v1/search', body);
    return res.json();
  }

  /**
   * POST /v1/admin/developers/approve (what the dashboard's register route calls). Needs the registry's
   * webhook secret as a bearer token. The response carries the new developer's private key, encrypted
   * under SHA-256(`state`), and it is returned exactly once.
   */
  async approveDeveloper(adminSecret: string, body: { name: string; state: string; metadata?: Record<string, string> }): Promise<DeveloperApproval> {
    const res = await this.request('POST', '/v1/admin/developers/approve', body, { Authorization: `Bearer ${adminSecret}` });
    const data = (await res.json().catch(() => ({}))) as Partial<DeveloperApproval>;
    if (!data.developer_id || !data.private_key_enc || !data.public_key) throw new AgentDnsError('AgentDNS approve response was incomplete', res.status);
    return { developer_id: data.developer_id, private_key_enc: data.private_key_enc, public_key: data.public_key };
  }

  /** GET /v1/handles/{handle}/available. */
  async handleAvailable(handle: string): Promise<boolean> {
    const res = await this.request('GET', `/v1/handles/${encodeURIComponent(handle)}/available`);
    return ((await res.json().catch(() => ({}))) as { available?: boolean }).available === true;
  }

  /** POST /v1/handles. 409 (taken) surfaces as `AgentDnsError(status 409)`. */
  async claimHandle(body: HandleClaim): Promise<void> {
    await this.request('POST', '/v1/handles', body);
  }

  /** POST /v1/handles/{handle}/verify, the same self-asserted "github" verification the dashboard records. */
  async verifyHandle(handle: string): Promise<void> {
    await this.request('POST', `/v1/handles/${encodeURIComponent(handle)}/verify`, { method: 'github', proof: handle });
  }

  private async request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined && !headers ? undefined : { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new AgentDnsError(`AgentDNS unreachable: ${(err as Error).message}`, undefined);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 500);
      throw new AgentDnsError(`AgentDNS ${method} ${path} -> ${res.status}`, res.status, text);
    }
    return res;
  }
}

/** Map a registry failure to the client-facing error without leaking internals. */
export function toGatewayError(err: unknown): ApiError {
  if (err instanceof AgentDnsError) {
    return new ApiError('GATEWAY_UNAVAILABLE', 'AgentDNS registration failed', {
      agentDnsStatus: err.status ?? null,
      agentDnsMessage: err.body || err.message,
    });
  }
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL');
}

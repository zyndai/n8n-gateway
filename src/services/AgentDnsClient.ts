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
  async getEntity(entityId: string): Promise<{ entity_id?: string; public_key?: string; status?: string } | null> {
    try {
      const res = await this.request('GET', `/v1/entities/${encodeURIComponent(entityId)}`);
      return (await res.json()) as { entity_id?: string; public_key?: string; status?: string };
    } catch (err) {
      if (err instanceof AgentDnsError && err.status === 404) return null;
      throw err;
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
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

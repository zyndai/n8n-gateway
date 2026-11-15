// Checks every Studio API route makes before it does anything. Pure, so they are easy to test.
import { AgentError, type AgentErrorCode } from './agents/service';
import { GatewayError } from './gateway/client';
import { McpError } from './n8n/mcp';
import { N8nError } from './n8n/rest';
import { publicOrigin } from './redirect';

type Req = { url: string; method: string; headers: { get(name: string): string | null } };

/**
 * A request that changes something must come from Studio's own pages: a JSON body (a plain form post from another
 * site cannot send one) and, when the browser says where it came from, the same origin.
 */
export function guardWrite(request: Req, env: Record<string, string | undefined> = process.env): 'ok' | 'forbidden' | 'unsupported' {
  const origin = request.headers.get('origin');
  if (origin && origin !== publicOrigin(request, env)) return 'forbidden';
  if (request.method !== 'DELETE' && !(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return 'unsupported';
  return 'ok';
}

const STATUS: Record<AgentErrorCode, number> = {
  'not-found': 404,
  limit: 429,
  'bad-input': 400,
  'no-workflow': 409,
  'not-ready': 409,
  'not-live': 409,
  registration: 502,
  unavailable: 503,
};

/** Maps anything thrown to a status and a code the UI has plain words for. Raw messages never leave the server. */
export function errorBody(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof AgentError) return { status: STATUS[err.code], body: { error: err.code } };
  if (err instanceof GatewayError) {
    if (err.status === 404) return { status: 404, body: { error: 'not-found' } };
    if (err.status === 401 || err.status === 403) return { status: 503, body: { error: 'unavailable' } };
    return { status: 502, body: { error: 'unavailable' } };
  }
  // n8n or the platform's own services being down is not the person's doing: say so plainly.
  if (err instanceof McpError || err instanceof N8nError) return { status: 502, body: { error: 'unavailable' } };
  return { status: 500, body: { error: 'unavailable' } };
}

/** A body that must be a JSON object, or null. */
export async function readJson(request: { json(): Promise<unknown> }): Promise<Record<string, unknown> | null> {
  try {
    const v = await request.json();
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

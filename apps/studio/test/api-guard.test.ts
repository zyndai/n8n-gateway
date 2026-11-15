import { describe, expect, it } from 'vitest';
import { AgentError } from '@/lib/agents/service';
import { errorBody, guardWrite, readJson } from '@/lib/api-guard';
import { GatewayError } from '@/lib/gateway/client';
import { McpError } from '@/lib/n8n/mcp';
import { N8nError } from '@/lib/n8n/rest';

const req = (method: string, headers: Record<string, string>, url = 'https://studio.example.com/api/agents') => ({ url, method, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } });
const env = { STUDIO_PUBLIC_URL: 'https://studio.example.com' };

describe('guardWrite', () => {
  it('accepts a JSON request from Studio\'s own page', () => {
    expect(guardWrite(req('POST', { origin: 'https://studio.example.com', 'content-type': 'application/json' }), env)).toBe('ok');
    expect(guardWrite(req('POST', { 'content-type': 'application/json; charset=utf-8' }), env)).toBe('ok');
  });
  it('refuses a request that another site started', () => {
    expect(guardWrite(req('POST', { origin: 'https://evil.example', 'content-type': 'application/json' }), env)).toBe('forbidden');
    expect(guardWrite(req('DELETE', { origin: 'https://evil.example' }), env)).toBe('forbidden');
    expect(guardWrite(req('POST', { origin: 'null', 'content-type': 'application/json' }), env)).toBe('forbidden');
  });
  it('refuses a plain form post, which a page on another site can send', () => {
    expect(guardWrite(req('POST', { 'content-type': 'application/x-www-form-urlencoded' }), env)).toBe('unsupported');
    expect(guardWrite(req('POST', { 'content-type': 'text/plain' }), env)).toBe('unsupported');
    expect(guardWrite(req('POST', {}), env)).toBe('unsupported');
  });
  it('lets a DELETE through without a body', () => {
    expect(guardWrite(req('DELETE', { origin: 'https://studio.example.com' }), env)).toBe('ok');
  });
});

describe('errorBody', () => {
  it('turns every kind of failure into a status and a code, never a message', () => {
    expect(errorBody(new AgentError('not-found', 'secret detail'))).toEqual({ status: 404, body: { error: 'not-found' } });
    expect(errorBody(new AgentError('bad-input', 'x'))).toEqual({ status: 400, body: { error: 'bad-input' } });
    expect(errorBody(new AgentError('not-ready', 'x', ['Step "Run code" is not allowed']))).toEqual({ status: 409, body: { error: 'not-ready' } });
    expect(errorBody(new AgentError('limit', 'x')).status).toBe(429);
    expect(errorBody(new AgentError('registration', 'x')).status).toBe(502);
    expect(errorBody(new GatewayError('Listing not found', 404, 'NOT_FOUND'))).toEqual({ status: 404, body: { error: 'not-found' } });
    expect(errorBody(new GatewayError('bad token', 401, 'AUTH_INVALID'))).toEqual({ status: 503, body: { error: 'unavailable' } });
    expect(errorBody(new GatewayError('down', 502, 'UNREACHABLE'))).toEqual({ status: 502, body: { error: 'unavailable' } });
    expect(errorBody(new McpError('n8n could not be reached'))).toEqual({ status: 502, body: { error: 'unavailable' } });
    expect(errorBody(new N8nError('n8n answered 500', 500))).toEqual({ status: 502, body: { error: 'unavailable' } });
    expect(errorBody(new Error('stack at /opt/app/secret.ts'))).toEqual({ status: 500, body: { error: 'unavailable' } });
    expect(JSON.stringify(errorBody(new AgentError('not-ready', 'secret detail', ['Step x'])))).not.toMatch(/secret|Step/);
  });
});

describe('readJson', () => {
  it('returns an object, and null for anything else', async () => {
    expect(await readJson({ json: async () => ({ a: 1 }) })).toEqual({ a: 1 });
    for (const v of [[1], 'x', 3, null]) expect(await readJson({ json: async () => v })).toBeNull();
    expect(await readJson({ json: async () => Promise.reject(new Error('bad json')) })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { N8nError, createCredential, restWorkflowWriter } from '@/lib/n8n/rest';

function fakeFetch(reply: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply(String(input), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}
const cfg = { apiUrl: 'https://n8n.example.com/', apiKey: 'key-1' };
const body = { name: 'A', nodes: [{ name: 'x' }], connections: {}, settings: { executionOrder: 'v1' } };

describe('restWorkflowWriter', () => {
  it('creates a workflow with only the fields n8n accepts and returns its id', async () => {
    const f = fakeFetch(() => Response.json({ id: 'wf9', active: false }));
    const id = await restWorkflowWriter(cfg, f.impl).create({ ...body, ...({ id: 'nope', active: true, tags: [] } as object) } as typeof body);
    expect(id).toBe('wf9');
    expect(f.calls[0]?.url).toBe('https://n8n.example.com/api/v1/workflows');
    expect(f.calls[0]?.init.method).toBe('POST');
    expect((f.calls[0]?.init.headers as Record<string, string>)['X-N8N-API-KEY']).toBe('key-1');
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual(body);
  });
  it('replaces a workflow without putting a live one\'s change live', async () => {
    const f = fakeFetch(() => Response.json({ id: 'wf9' }));
    await restWorkflowWriter(cfg, f.impl).replace('wf9', body);
    expect(f.calls[0]?.url).toBe('https://n8n.example.com/api/v1/workflows/wf9?publishIfActive=false');
    expect(f.calls[0]?.init.method).toBe('PUT');
  });
  it('refuses an id that is not one before calling n8n', async () => {
    const f = fakeFetch(() => Response.json({}));
    await expect(restWorkflowWriter(cfg, f.impl).replace('../credentials', body)).rejects.toBeInstanceOf(N8nError);
    expect(f.calls).toEqual([]);
  });
  it('keeps the first line of n8n\'s error, and says so when n8n gives no id', async () => {
    const bad = fakeFetch(() => Response.json({ message: 'request/body/nodes must be array\nstack...' }, { status: 400 }));
    await expect(restWorkflowWriter(cfg, bad.impl).create(body)).rejects.toThrow('request/body/nodes must be array');
    const empty = fakeFetch(() => Response.json({}));
    await expect(restWorkflowWriter(cfg, empty.impl).create(body)).rejects.toThrow(/did not return/);
  });
  it('says plainly when n8n cannot be reached', async () => {
    const impl = (async () => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await expect(restWorkflowWriter(cfg, impl).create(body)).rejects.toMatchObject({ status: 502, message: 'n8n could not be reached' });
  });
});

describe('createCredential', () => {
  it('still creates a credential and returns its id', async () => {
    const f = fakeFetch(() => Response.json({ id: 'c1', name: 'Zynd · ada', type: 'zyndApi' }));
    expect(await createCredential(cfg, { name: 'Zynd · ada', type: 'zyndApi', data: { apiKey: 'k' } }, f.impl)).toEqual({ id: 'c1', name: 'Zynd · ada', type: 'zyndApi' });
  });
});

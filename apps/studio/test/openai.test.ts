import { describe, expect, it } from 'vitest';
import { OpenAIClient, OpenAIError, type ToolSpec } from '@/lib/openai';

const sse = (events: unknown[]) => events.map((e) => `event: x\ndata: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');

/** A streamed response whose body is cut into pieces of `size` bytes. */
function streamed(text: string, size: number, init: ResponseInit = { status: 200 }): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
        c.close();
      },
    }),
    init,
  );
}

const events = [
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.output_text.delta', delta: 'Hel' },
  { type: 'response.output_text.delta', delta: 'lo ☺' },
  { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'find_helpers', arguments: '{"query":"company check"}' } },
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1' } },
  { type: 'response.completed', response: { id: 'resp_2', output: [] } },
  '[DONE]',
];
const tools: ToolSpec[] = [{ type: 'function', name: 'find_helpers', description: 'd', parameters: { type: 'object' } }];
const req = { model: 'gpt-x', instructions: 'be nice', input: [{ role: 'user' as const, content: 'hi' }], tools };

describe('OpenAIClient.turn', () => {
  it.each([1, 3, 7, 64, 100_000])('reads a stream cut into %i-byte pieces', async (size) => {
    const seen: string[] = [];
    const client = new OpenAIClient({ apiKey: 'sk-test', fetchImpl: (async () => streamed(sse(events), size)) as typeof fetch });
    const out = await client.turn(req, (d) => seen.push(d));
    expect(seen.join('')).toBe('Hello ☺');
    expect(out).toEqual({ responseId: 'resp_2', text: 'Hello ☺', calls: [{ callId: 'call_1', name: 'find_helpers', arguments: '{"query":"company check"}' }] });
  });

  it('sends the key as a header only, asks for a stored stream, and continues from a previous response', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const client = new OpenAIClient({ apiKey: 'sk-secret', fetchImpl: (async (url: string, init: RequestInit) => ((seen = { url, init }), streamed(sse(events), 50))) as typeof fetch });
    await client.turn({ ...req, previousResponseId: 'resp_0' }, () => {});
    expect(seen?.url).toBe('https://api.openai.com/v1/responses');
    expect((seen?.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret');
    const body = JSON.parse(String(seen?.init.body));
    expect(body).toMatchObject({ model: 'gpt-x', instructions: 'be nice', store: true, stream: true, parallel_tool_calls: false, previous_response_id: 'resp_0', input: [{ role: 'user', content: 'hi' }] });
    expect(JSON.stringify(body)).not.toContain('sk-secret');
  });

  it('works when the final event has no blank line after it', async () => {
    const text = `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_9' } })}`;
    const out = await new OpenAIClient({ apiKey: 'k', fetchImpl: (async () => streamed(text, 5)) as typeof fetch }).turn(req, () => {});
    expect(out.responseId).toBe('resp_9');
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate'],
    [404, 'model'],
    [500, 'other'],
  ])('maps an HTTP %i to "%s" and never echoes the key', async (status, kind) => {
    const client = new OpenAIClient({ apiKey: 'sk-secret', fetchImpl: (async () => Response.json({ error: { message: 'Incorrect API key provided: sk-secret' } }, { status })) as typeof fetch });
    const err = (await client.turn(req, () => {}).catch((e: unknown) => e)) as OpenAIError;
    expect(err).toBeInstanceOf(OpenAIError);
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });

  it('reports a network failure, a failed response and a stream that ends early', async () => {
    const down = new OpenAIClient({ apiKey: 'k', fetchImpl: (async () => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch });
    expect(((await down.turn(req, () => {}).catch((e: unknown) => e)) as OpenAIError).kind).toBe('unreachable');

    const failed = new OpenAIClient({ apiKey: 'k', fetchImpl: (async () => streamed(sse([{ type: 'response.failed', response: { error: { message: 'The model does not exist' } } }]), 20)) as typeof fetch });
    expect(((await failed.turn(req, () => {}).catch((e: unknown) => e)) as OpenAIError).kind).toBe('model');

    const cut = new OpenAIClient({ apiKey: 'k', fetchImpl: (async () => streamed(sse([{ type: 'response.output_text.delta', delta: 'x' }]), 20)) as typeof fetch });
    await expect(cut.turn(req, () => {})).rejects.toThrow(/ended the reply early/);

    const errEvent = new OpenAIClient({ apiKey: 'k', fetchImpl: (async () => streamed(sse([{ type: 'error', message: 'overloaded' }]), 20)) as typeof fetch });
    await expect(errEvent.turn(req, () => {})).rejects.toThrow(/overloaded/);
  });

  it('stops when told to', async () => {
    const ac = new AbortController();
    const client = new OpenAIClient({ apiKey: 'k', fetchImpl: (async (_u: string, init: RequestInit) => (init.signal?.aborted ? Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) : streamed(sse(events), 9))) as typeof fetch });
    ac.abort();
    await expect(client.turn(req, () => {}, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

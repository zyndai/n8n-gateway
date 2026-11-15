import { describe, expect, it } from 'vitest';
import type { BuildEvent } from '@/lib/builder/events';
import { plainBuilderError, runBuilder } from '@/lib/builder/loop';
import type { BuilderTools } from '@/lib/builder/tools';
import { OpenAIError } from '@/lib/openai';
import { FakeModel, outputsOf } from './helpers/fakeOpenAI';

const tools = (run: BuilderTools['run'] = async (name) => JSON.stringify({ ran: name })): BuilderTools & { ran: string[] } => {
  const t = { specs: [{ type: 'function' as const, name: 'a', description: 'd', parameters: {} }], ran: [] as string[], run: async (n: string, a: string) => (t.ran.push(`${n}(${a})`), run(n, a)) };
  return t;
};
const base = (model: FakeModel, t: BuilderTools, events: BuildEvent[], over = {}) => ({ openai: model, model: 'm', instructions: 'i', tools: t, userText: 'Check suppliers', emit: (e: BuildEvent) => void events.push(e), ...over });

describe('runBuilder', () => {
  it('streams the reply and ends at a turn with no tool calls', async () => {
    const events: BuildEvent[] = [];
    const model = new FakeModel([{ text: 'Hello there' }]);
    const out = await runBuilder(base(model, tools(), events));
    expect(out).toEqual({ responseId: 'resp_1', finished: true });
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Hello there');
    expect(model.requests[0]).toMatchObject({ model: 'm', instructions: 'i', input: [{ role: 'user', content: 'Check suppliers' }] });
    expect(model.requests[0]?.previousResponseId).toBeUndefined();
  });

  it('runs the tools the model asks for, one at a time, and answers each by call id', async () => {
    const t = tools();
    const model = new FakeModel([{ text: 'Let me look.', calls: [{ name: 'find_helpers', args: { query: 'x' } }, { name: 'list_data_sources', args: {} }] }, { text: 'Found two.' }]);
    const events: BuildEvent[] = [];
    const out = await runBuilder(base(model, t, events));
    expect(t.ran).toEqual(['find_helpers({"query":"x"})', 'list_data_sources({})']);
    expect(model.requests[1]?.previousResponseId).toBe('resp_1');
    expect(outputsOf(model.requests[1]?.input ?? [])).toEqual([
      { id: 'call_1_0', output: { ran: 'find_helpers' } },
      { id: 'call_1_1', output: { ran: 'list_data_sources' } },
    ]);
    expect(out).toEqual({ responseId: 'resp_2', finished: true });
  });

  it('puts a new line between the text of two turns', async () => {
    const events: BuildEvent[] = [];
    await runBuilder(base(new FakeModel([{ text: 'First.', calls: [{ name: 'a', args: {} }] }, { text: 'Second.' }]), tools(), events));
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toBe('First.\n\nSecond.');
  });

  it('continues an earlier conversation', async () => {
    const model = new FakeModel([{ text: 'ok' }]);
    await runBuilder(base(model, tools(), [], { previousResponseId: 'resp_old' }));
    expect(model.requests[0]?.previousResponseId).toBe('resp_old');
  });

  it('hands the model a tool\'s error as its answer, so it can recover', async () => {
    const model = new FakeModel([{ calls: [{ name: 'a', args: {} }] }, { text: 'Sorry.' }]);
    await runBuilder(base(model, tools(async () => JSON.stringify({ error: 'nope' })), []));
    expect(outputsOf(model.requests[1]?.input ?? [])[0]?.output).toEqual({ error: 'nope' });
  });

  it('stops after the turn limit with one last turn that cannot call tools, so the conversation stays continuable', async () => {
    const model = new FakeModel((_r, n) => (n < 3 ? { calls: [{ name: 'a', args: {} }] } : { text: 'Wrapping up.' }));
    const out = await runBuilder(base(model, tools(), [], { maxTurns: 3 }));
    expect(out.finished).toBe(false);
    expect(model.requests).toHaveLength(4);
    expect(model.requests[3]?.tools).toEqual([]);
    expect(outputsOf(model.requests[3]?.input ?? [])).toHaveLength(1); // the last tool results are settled
    expect(out.responseId).toBe('resp_4');
  });

  it('does nothing once aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const model = new FakeModel([{ text: 'x' }]);
    expect(await runBuilder(base(model, tools(), [], { signal: ac.signal }))).toEqual({ responseId: '', finished: false });
    expect(model.requests).toEqual([]);
  });
});

describe('plainBuilderError', () => {
  it('never shows raw text', () => {
    expect(plainBuilderError(new OpenAIError('Incorrect API key sk-live-abc', 'auth', 401))).not.toContain('sk-live');
    expect(plainBuilderError(new OpenAIError('x', 'rate', 429))).toMatch(/busy/);
    expect(plainBuilderError(new OpenAIError('x', 'auth', 401))).toMatch(/not switched on/);
    expect(plainBuilderError(new OpenAIError('x', 'unreachable'))).toMatch(/could not reach/);
    expect(plainBuilderError(new Error('ECONNRESET at 10.0.0.1'))).toMatch(/Something went wrong/);
    expect(plainBuilderError(new Error('ECONNRESET at 10.0.0.1'))).not.toContain('10.0.0.1');
  });
});

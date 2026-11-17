import { describe, expect, it } from 'vitest';
import { decodeEvents, encodeEvent, type BuildEvent } from '@/lib/builder/events';

const events: BuildEvent[] = [
  { type: 'text', delta: 'Hello ☺ "quoted"\nnew line' },
  { type: 'preview', preview: { name: 'Supplier Check', does: 'Checks.', helpers: [{ name: 'Counterparty Check', what: 'x', priceUsd: '0.05' }], costUsd: '0.050000', suggestedPriceUsd: '0.15' } },
  { type: 'progress', step: 'testing' },
  { type: 'thread', token: 'resp_1.123.sig' },
  { type: 'error', message: 'Plain words.' },
  { type: 'done' },
];

describe('build event stream', () => {
  it('round-trips every event, one per line, even when the text has line breaks', () => {
    const wire = events.map(encodeEvent).join('');
    expect(wire.split('\n').filter(Boolean)).toHaveLength(events.length);
    expect(decodeEvents(wire)).toEqual({ events, rest: '' });
  });

  it.each([1, 2, 5, 17, 1000])('reads a stream arriving in %i-character pieces', (size) => {
    const wire = events.map(encodeEvent).join('');
    const got: BuildEvent[] = [];
    let buf = '';
    for (let i = 0; i < wire.length; i += size) {
      const out = decodeEvents(buf + wire.slice(i, i + size));
      got.push(...out.events);
      buf = out.rest;
    }
    expect(got).toEqual(events);
    expect(buf).toBe('');
  });

  it('keeps an unfinished line for the next piece and skips damaged or foreign lines', () => {
    const out = decodeEvents(`{"type":"done"}\nnot json\n{"nope":1}\n[1]\n{"type":"progr`);
    expect(out.events).toEqual([{ type: 'done' }]);
    expect(out.rest).toBe('{"type":"progr');
  });
});

describe('the build view (S5.2, S5.3)', () => {
  it('keeps one line per activity id, updated in place, and knows which one is running', async () => {
    const { applyEvent, currentActivity, newView } = await import('@/lib/builder/events');
    let v = newView('j', 'hi', 0);
    v = applyEvent(v, { type: 'activity', activity: { id: 'a1', label: 'Searching', state: 'running' } });
    v = applyEvent(v, { type: 'activity', activity: { id: 'a2', label: 'Planned', state: 'done' } });
    expect(currentActivity(v)?.label).toBe('Searching');
    v = applyEvent(v, { type: 'activity', activity: { id: 'a1', label: 'Found 2', state: 'done' } });
    expect(v.activity.map((a) => a.label)).toEqual(['Found 2', 'Planned']);
    expect(currentActivity(v)).toBeUndefined();
  });
  it('closes lines still running when the message ends: done on success, failed on an error', async () => {
    const { applyEvent, newView } = await import('@/lib/builder/events');
    const running = applyEvent(newView('j', 'hi', 0), { type: 'activity', activity: { id: 'a', label: 'x', state: 'running' } });
    expect(applyEvent(running, { type: 'done' }).activity[0]?.state).toBe('done');
    expect(applyEvent(running, { type: 'error', message: 'Stopped.' })).toMatchObject({ status: 'error', error: 'Stopped.', activity: [{ state: 'failed' }] });
  });
  it('replaces the picture whole, and keeps the last forty lines', async () => {
    const { applyEvent, newView } = await import('@/lib/builder/events');
    let v = applyEvent(newView('j', 'hi', 0), { type: 'blueprint', parts: [{ id: 'brain', kind: 'brain', state: 'planned' }] });
    v = applyEvent(v, { type: 'blueprint', parts: [{ id: 'brain', kind: 'brain', state: 'ready' }] });
    expect(v.parts).toEqual([{ id: 'brain', kind: 'brain', state: 'ready' }]);
    for (let i = 0; i < 50; i++) v = applyEvent(v, { type: 'activity', activity: { id: `a${i}`, label: String(i), state: 'done' } });
    expect(v.activity).toHaveLength(40);
    expect(v.activity[0]?.id).toBe('a10');
  });
  it('the preview scripts end where a real build ends', async () => {
    const { applyEvent, newView } = await import('@/lib/builder/events');
    const { sampleBuildScript, sampleEditScript } = await import('@/lib/sample');
    for (const script of [sampleBuildScript(), sampleEditScript()]) {
      const v = script.reduce((acc, [, e]) => applyEvent(acc, e), newView('s', 'x', 0));
      expect(v).toMatchObject({ status: 'done', step: 5 });
      expect(v.activity.every((a) => a.state === 'done')).toBe(true);
      expect(v.parts.find((p) => p.kind === 'answer')?.state).toBe('used');
    }
  });
});

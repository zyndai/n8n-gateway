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

import { afterEach, describe, expect, it } from 'vitest';
import { applyEvent, newView, type BuildEvent, type Numbered } from '@/lib/builder/events';
import { STOPPED, TOO_LONG, follow, getJob, jobKey, resetJobs, startJob, stopJob, type Runner } from '@/lib/builder/jobs';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A runner the test drives by hand: `emit` events, then `finish`. */
function manual() {
  let emit: (e: BuildEvent) => void = () => {};
  let finish: () => void = () => {};
  let signal: AbortSignal | undefined;
  const run: Runner = (e, s) => {
    emit = e;
    signal = s;
    return new Promise<void>((resolve) => {
      finish = resolve;
      s.addEventListener('abort', () => resolve());
    });
  };
  return { run, emit: (e: BuildEvent) => emit(e), finish: () => finish(), signal: () => signal };
}

afterEach(() => resetJobs());

describe('background build jobs (S5.2)', () => {
  it('numbers events and keeps a view that matches what a screen would build from them', async () => {
    const m = manual();
    const job = startJob(jobKey('u1', 'a1'), 'Check suppliers', m.run, { id: 'job-1', now: () => 1000 });
    if (job === 'busy') throw new Error('busy');
    m.emit({ type: 'text', delta: 'Looking' });
    m.emit({ type: 'progress', step: 'building' });
    m.emit({ type: 'text', delta: ' now.' });
    m.emit({ type: 'thread', token: 't1' });
    m.emit({ type: 'done' });
    m.finish();
    await tick();
    expect(job.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(job.view).toMatchObject({ id: 'job-1', status: 'done', message: 'Check suppliers', reply: 'Looking now.', step: 2, thread: 't1', seq: 5 });
    expect(job.events.reduce(applyEvent, newView('job-1', 'Check suppliers', 1000))).toEqual(job.view);
  });

  it('runs one job per person and agent at a time', async () => {
    const m = manual();
    expect(startJob(jobKey('u1', 'a1'), 'x', m.run)).not.toBe('busy');
    expect(startJob(jobKey('u1', 'a1'), 'y', manual().run)).toBe('busy');
    expect(startJob(jobKey('u2', 'a1'), 'y', manual().run)).not.toBe('busy');
    expect(startJob(jobKey('u1', 'a2'), 'y', manual().run)).not.toBe('busy');
    m.emit({ type: 'done' });
    m.finish();
    await tick();
    expect(startJob(jobKey('u1', 'a1'), 'again', manual().run)).not.toBe('busy');
  });

  it('a screen that comes back gets everything after the last event it saw, then live ones, then the end', async () => {
    const m = manual();
    const job = startJob('k', 'x', m.run);
    if (job === 'busy') throw new Error('busy');
    m.emit({ type: 'text', delta: 'a' });
    m.emit({ type: 'text', delta: 'b' });
    const got: Numbered[] = [];
    let ended = false;
    follow(job, 1, (e) => got.push(e), () => (ended = true));
    expect(got.map((e) => e.seq)).toEqual([2]);
    m.emit({ type: 'text', delta: 'c' });
    expect(got.map((e) => e.seq)).toEqual([2, 3]);
    expect(ended).toBe(false);
    m.emit({ type: 'done' });
    m.finish();
    await tick();
    expect(got.map((e) => e.type)).toEqual(['text', 'text', 'done']);
    expect(ended).toBe(true);
  });

  it('two screens see the same events, and one leaving does not stop the job', async () => {
    const m = manual();
    const job = startJob('k', 'x', m.run);
    if (job === 'busy') throw new Error('busy');
    const a: number[] = [];
    const b: number[] = [];
    const leave = new AbortController();
    follow(job, 0, (e) => a.push(e.seq), () => {}, leave.signal);
    follow(job, 0, (e) => b.push(e.seq), () => {});
    m.emit({ type: 'text', delta: '1' });
    leave.abort();
    m.emit({ type: 'text', delta: '2' });
    m.emit({ type: 'done' });
    m.finish();
    await tick();
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2, 3]);
    expect(job.view.status).toBe('done');
  });

  it('finishes with nobody watching, and can be read afterwards for thirty minutes', async () => {
    let t = 0;
    const m = manual();
    startJob('k', 'x', m.run, { now: () => t });
    m.emit({ type: 'thread', token: 'tok' });
    m.emit({ type: 'done' });
    m.finish();
    await tick();
    t = 29 * 60_000;
    expect(getJob('k', t)?.view).toMatchObject({ status: 'done', thread: 'tok' });
    const late: Numbered[] = [];
    let ended = false;
    follow(getJob('k', t)!, 0, (e) => late.push(e), () => (ended = true));
    expect(late).toHaveLength(2);
    expect(ended).toBe(true);
    expect(getJob('k', 31 * 60_000)).toBeUndefined();
  });

  it('can be stopped, and then says so in plain words', async () => {
    const m = manual();
    const job = startJob('k', 'x', m.run);
    if (job === 'busy') throw new Error('busy');
    expect(stopJob('k')).toBe(true);
    await tick();
    expect(m.signal()?.aborted).toBe(true);
    expect(job.view).toMatchObject({ status: 'error', error: STOPPED });
    expect(stopJob('k')).toBe(false);
  });

  it('stops a message that runs too long', async () => {
    const m = manual();
    const job = startJob('k', 'x', m.run, { limitMs: 5 });
    if (job === 'busy') throw new Error('busy');
    await new Promise((r) => setTimeout(r, 30));
    expect(job.view).toMatchObject({ status: 'error', error: TOO_LONG });
  });

  it('ignores events after the end, and keeps pings out of the log', async () => {
    const m = manual();
    const job = startJob('k', 'x', m.run);
    if (job === 'busy') throw new Error('busy');
    m.emit({ type: 'ping' });
    m.emit({ type: 'done' });
    m.finish();
    await tick();
    m.emit({ type: 'text', delta: 'late' });
    expect(job.events.map((e) => e.type)).toEqual(['done']);
    expect(job.view.reply).toBe('');
  });
});

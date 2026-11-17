// Builder messages as background jobs (S5.2). A build used to live inside the browser's request: a reload lost the
// stream, the reply and the conversation pointer. Now the request only starts a job; the job runs in this process
// until it ends, and any screen of the same person can read it again (a snapshot, then every event after a number).
//
// Kept in memory, on `globalThis` so a dev reload keeps it. Studio runs as one process (docker-compose has one
// container), so this is the whole truth; a restart loses running jobs, and the screen then says the message was
// interrupted. Pure enough to test without a server: `run` is passed in.
import { applyEvent, newView, type BuildEvent, type BuildView, type Numbered } from './events';

/** How long a finished job can still be read, so a screen that comes back later sees how it ended. */
const KEEP_MS = 30 * 60_000;
/** The longest one message may take before it is stopped. */
export const JOB_LIMIT_MS = 8 * 60_000;
/** A runaway stream never grows memory without bound: text beyond this is joined into the last text event. */
const MAX_EVENTS = 5_000;

export const STOPPED = 'Stopped. Your agent is saved as it was: send a message to carry on.';
export const TOO_LONG = 'This took too long, so it was stopped. Your agent is saved: send your message again to carry on.';

export interface Job {
  key: string;
  view: BuildView;
  events: Numbered[];
  endedAt?: number;
  controller: AbortController;
  listeners: Set<(e: Numbered) => void>;
}

interface Registry {
  jobs: Map<string, Job>;
}

const registry = (): Registry => {
  const g = globalThis as typeof globalThis & { __studioBuildJobs?: Registry };
  g.__studioBuildJobs ??= { jobs: new Map() };
  return g.__studioBuildJobs;
};

/** One job per person and agent. */
export const jobKey = (uid: string, agentId: string) => `${uid}:${agentId}`;

function sweep(now: number): void {
  for (const [key, job] of registry().jobs) if (job.endedAt !== undefined && now - job.endedAt > KEEP_MS) registry().jobs.delete(key);
}

export function getJob(key: string, now: number = Date.now()): Job | undefined {
  sweep(now);
  return registry().jobs.get(key);
}

function append(job: Job, e: BuildEvent): void {
  if (job.endedAt !== undefined) return;
  if (e.type === 'ping') return;
  const last = job.events[job.events.length - 1];
  if (job.events.length >= MAX_EVENTS && e.type === 'text' && last?.type === 'text') {
    last.delta += e.delta;
    job.view = applyEvent(job.view, e);
    return;
  }
  const numbered = { ...e, seq: job.view.seq + 1 } as Numbered;
  job.events.push(numbered);
  job.view = applyEvent(job.view, numbered);
  for (const l of job.listeners) l(numbered);
}

function end(job: Job, now: number): void {
  if (job.endedAt !== undefined) return;
  // A run that stopped without saying how it ended says so now, in plain words.
  if (job.view.status === 'running') {
    const reason = job.controller.signal.reason as { name?: string } | undefined;
    append(job, { type: 'error', message: reason?.name === 'TimeoutError' ? TOO_LONG : STOPPED });
  }
  job.endedAt = now;
  for (const l of job.listeners) l({ type: 'ping', seq: job.view.seq });
  job.listeners.clear();
}

export type Runner = (emit: (e: BuildEvent) => void, signal: AbortSignal) => Promise<void>;

/**
 * Starts a job, unless one is still running for this person and agent. The run is not tied to any request: it goes
 * on when the browser goes away, and ends by itself after {@link JOB_LIMIT_MS}.
 */
export function startJob(key: string, message: string, run: Runner, opts: { now?: () => number; limitMs?: number; id?: string } = {}): Job | 'busy' {
  const now = opts.now ?? Date.now;
  const existing = getJob(key, now());
  if (existing && existing.endedAt === undefined) return 'busy';
  const controller = new AbortController();
  const job: Job = { key, view: newView(opts.id ?? crypto.randomUUID(), message, now()), events: [], controller, listeners: new Set() };
  registry().jobs.set(key, job);
  const timer = setTimeout(() => controller.abort(new DOMException('The build took too long', 'TimeoutError')), opts.limitMs ?? JOB_LIMIT_MS);
  timer.unref?.();
  void (async () => {
    try {
      await run((e) => append(job, e), controller.signal);
    } catch {
      /* the runner never throws; if it ever does, `end` reports it in plain words */
    } finally {
      clearTimeout(timer);
      end(job, now());
    }
  })();
  return job;
}

/** Stops a running job. Returns false when nothing was running. */
export function stopJob(key: string): boolean {
  const job = registry().jobs.get(key);
  if (!job || job.endedAt !== undefined) return false;
  job.controller.abort(new DOMException('Stopped by the person', 'AbortError'));
  return true;
}

/**
 * Follows a job: every event after `after`, then each new one as it happens, until the job ends or `signal` fires.
 * `onEnd` is called once, when there is nothing more to send.
 */
export function follow(job: Job, after: number, send: (e: Numbered) => void, onEnd: () => void, signal?: AbortSignal): () => void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    job.listeners.delete(listener);
    onEnd();
  };
  const listener = (e: Numbered) => {
    if (closed) return;
    if (e.type !== 'ping') send(e);
    if (job.endedAt !== undefined) close();
  };
  for (const e of job.events) if (e.seq > after) send(e);
  if (job.endedAt !== undefined) {
    close();
    return close;
  }
  job.listeners.add(listener);
  signal?.addEventListener('abort', close, { once: true });
  return close;
}

/** For tests: forget every job. */
export function resetJobs(): void {
  for (const job of registry().jobs.values()) job.controller.abort();
  registry().jobs.clear();
}

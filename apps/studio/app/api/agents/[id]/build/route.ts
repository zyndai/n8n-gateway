import { apiFailure, apiSession, json, readJson } from '@/lib/api';
import { BUILD_MESSAGE_MAX, runBuild } from '@/lib/builder/build';
import { encodeEvent, type Numbered } from '@/lib/builder/events';
import { follow, getJob, jobKey, startJob, stopJob, type Job } from '@/lib/builder/jobs';
import { agentsFor, services } from '@/lib/services';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const HEARTBEAT_MS = 15_000;

/** One job's events after `after`, one JSON object per line, until it ends or the browser goes away. */
function streamOf(job: Job, after: number, signal: AbortSignal): Response {
  // The job's id goes in a header, so a screen that loses the stream can ask for the rest of the same job.
  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (e: Numbered | { type: 'ping' }) => {
        try {
          controller.enqueue(encoder.encode(encodeEvent(e as Numbered)));
        } catch {
          /* the browser went away: the job carries on */
        }
      };
      const beat = setInterval(() => write({ type: 'ping' }), HEARTBEAT_MS);
      stop = follow(
        job,
        after,
        write,
        () => {
          clearInterval(beat);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
        signal,
      );
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Build-Job': job.view.id } });
}

/**
 * One builder message, run as a background job (S5.2). The answer streams back as numbered JSON events, but the job
 * does not depend on this request: if the browser goes away, it carries on, and GET picks it up again.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await apiSession(request, { write: true });
  if (session instanceof Response) return session;
  const body = await readJson(request);
  if (!body) return json(400, { error: 'bad-input' });

  let s;
  try {
    s = services();
  } catch (err) {
    return apiFailure(err, 'builder');
  }
  const { id } = await ctx.params;
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, BUILD_MESSAGE_MAX + 1) : '';
  const job = startJob(jobKey(session.uid, id), message, (emit, signal) =>
    runBuild(
      {
        agents: agentsFor(session),
        registry: s.registry,
        openai: s.openai,
        builderModel: s.builderModel,
        dataSources: s.deps.dataSources,
        sessionSecret: s.sessionSecret,
        log: console,
      },
      { agentId: id, message: body.message, thread: body.thread },
      emit,
      signal,
    ),
  );
  if (job === 'busy') return json(409, { error: 'busy' });
  return streamOf(job, 0, request.signal);
}

/**
 * Without `after`: the person's latest job for this agent as a snapshot (`{ job: null }` when there is none).
 * With `after=<seq>`: that job's events after `seq`, then live ones until it ends.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await apiSession(request, { write: false });
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const job = getJob(jobKey(session.uid, id));
  const after = new URL(request.url).searchParams.get('after');
  if (after === null) return json(200, { job: job?.view ?? null });
  const seq = Number(after);
  if (!job) return json(404, { error: 'not-found' });
  if (!Number.isInteger(seq) || seq < 0) return json(400, { error: 'bad-input' });
  return streamOf(job, seq, request.signal);
}

/** Stops the running job. The agent stays as it was saved so far. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await apiSession(request, { write: true });
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  return json(200, { stopped: stopJob(jobKey(session.uid, id)) });
}

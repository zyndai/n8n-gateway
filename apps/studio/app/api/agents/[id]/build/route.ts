import { apiFailure, apiSession, json, readJson } from '@/lib/api';
import { runBuild } from '@/lib/builder/build';
import { encodeEvent, type BuildEvent } from '@/lib/builder/events';
import { agentsFor, services } from '@/lib/services';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** One builder message. The answer streams back as one JSON event per line. */
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
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: BuildEvent) => {
        try {
          controller.enqueue(encoder.encode(encodeEvent(e)));
        } catch {
          /* the browser went away: the run carries on and finishes quietly */
        }
      };
      await runBuild(
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
        AbortSignal.timeout(280_000),
      );
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}

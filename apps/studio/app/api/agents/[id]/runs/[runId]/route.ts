import { apiFailure, apiSession, json } from '@/lib/api';
import { agentsFor } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** One run: still working, or its answer, the helpers used and what they cost. Never raw execution data. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string; runId: string }> }) {
  const session = await apiSession(request, { write: false });
  if (session instanceof Response) return session;
  try {
    const { id, runId } = await ctx.params;
    const run = await agentsFor(session).readChat(id, runId);
    return json(200, {
      status: run.status,
      ...(run.answer ? { answer: run.answer } : {}),
      helpers: run.helpers,
      costUsd: run.costUsd,
      ...(run.errorKind ? { errorKind: run.errorKind } : {}),
    });
  } catch (err) {
    return apiFailure(err, 'read run');
  }
}

import { apiFailure, apiSession, json, readJson } from '@/lib/api';
import type { ChatTurnIn } from '@/lib/agents/service';
import { agentsFor } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** Start one chat run. The browser then polls `/runs/<id>` until it ends. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await apiSession(request, { write: true });
  if (session instanceof Response) return session;
  const body = await readJson(request);
  if (!body || typeof body.message !== 'string') return json(400, { error: 'bad-input' });
  const history: ChatTurnIn[] = Array.isArray(body.history)
    ? (body.history as unknown[])
        .filter((t): t is { role: 'user' | 'agent'; text: string } => typeof t === 'object' && t !== null && ['user', 'agent'].includes((t as ChatTurnIn).role) && typeof (t as ChatTurnIn).text === 'string')
        .slice(-6)
    : [];
  try {
    const { id } = await ctx.params;
    const { executionId } = await agentsFor(session).startChat(id, body.message, history);
    return json(202, { runId: executionId });
  } catch (err) {
    return apiFailure(err, 'start run');
  }
}

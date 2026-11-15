import { apiFailure, apiSession, json } from '@/lib/api';
import { agentsFor } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** Take a live agent offline. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await apiSession(request, { write: true });
  if (session instanceof Response) return session;
  try {
    const { id } = await ctx.params;
    await agentsFor(session).pause(id);
    return json(200, { status: 'paused' });
  } catch (err) {
    return apiFailure(err, 'pause agent');
  }
}

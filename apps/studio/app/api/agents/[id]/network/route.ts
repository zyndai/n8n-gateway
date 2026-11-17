import { apiFailure, apiSession, json } from '@/lib/api';
import { agentsFor } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** What the picture of an agent's network starts from: the credit it has left and its own tools with their prices. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await apiSession(request, { write: false });
  if (session instanceof Response) return session;
  try {
    const { id } = await ctx.params;
    return json(200, await agentsFor(session).network(id));
  } catch (err) {
    return apiFailure(err, 'read network');
  }
}

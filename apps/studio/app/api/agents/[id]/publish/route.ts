import { apiFailure, apiSession, json, readJson } from '@/lib/api';
import { agentsFor } from '@/lib/services';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Confirm name, description and price, then put the agent live. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await apiSession(request, { write: true });
  if (session instanceof Response) return session;
  const body = await readJson(request);
  if (!body || typeof body.name !== 'string' || typeof body.summary !== 'string' || typeof body.priceUsd !== 'string') return json(400, { error: 'bad-input' });
  try {
    const { id } = await ctx.params;
    const listing = await agentsFor(session).publish(id, { name: body.name, summary: body.summary, priceUsd: body.priceUsd });
    return json(200, { status: 'live', name: listing.name });
  } catch (err) {
    return apiFailure(err, 'publish agent');
  }
}

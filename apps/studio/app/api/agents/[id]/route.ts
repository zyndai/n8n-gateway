import { apiFailure, apiSession, json, readJson } from '@/lib/api';
import { agentsFor } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** Save name, description and price. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await apiSession(request, { write: true });
  if (session instanceof Response) return session;
  const body = await readJson(request);
  if (!body) return json(400, { error: 'bad-input' });
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  try {
    const { id } = await ctx.params;
    const price = body.priceUsd === null ? null : text(body.priceUsd);
    const listing = await agentsFor(session).saveSettings(id, {
      ...(text(body.name) !== undefined ? { name: text(body.name) as string } : {}),
      ...(text(body.summary) !== undefined ? { summary: text(body.summary) as string } : {}),
      ...(price !== undefined ? { priceUsd: price } : {}),
    });
    return json(200, { name: listing.name, summary: listing.summary, priceUsd: listing.priceUsd });
  } catch (err) {
    return apiFailure(err, 'save settings');
  }
}

/** Delete the agent: pause it if live, archive its steps, remove it. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await apiSession(request, { write: true });
  if (session instanceof Response) return session;
  try {
    const { id } = await ctx.params;
    await agentsFor(session).remove(id);
    return json(200, { deleted: true });
  } catch (err) {
    return apiFailure(err, 'delete agent');
  }
}

import { apiFailure, apiSession, json } from '@/lib/api';
import { agentsFor } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** Create a draft agent (with starter credit when it is due). */
export async function POST(request: Request) {
  const session = await apiSession(request, { write: true });
  if (session instanceof Response) return session;
  try {
    const created = await agentsFor(session).create();
    return json(201, created);
  } catch (err) {
    return apiFailure(err, 'create agent');
  }
}

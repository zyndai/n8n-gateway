import 'server-only';
import { ConfigError, isPreview } from './env';
import { errorBody, guardWrite, readJson } from './api-guard';
import { getSession } from './session';
import type { StudioSession } from './session-cookie';

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * The common start of a Studio API route: preview mode has no real backend, writes must come from Studio's own pages,
 * and the person must be signed in. Returns the session, or the response to send back.
 */
export async function apiSession(request: Request, opts: { write: boolean }): Promise<StudioSession | Response> {
  if (isPreview()) return json(403, { error: 'preview' });
  if (opts.write) {
    const g = guardWrite(request);
    if (g === 'forbidden') return json(403, { error: 'forbidden' });
    if (g === 'unsupported') return json(415, { error: 'bad-input' });
  }
  try {
    const session = await getSession();
    return session ?? json(401, { error: 'signed-out' });
  } catch (err) {
    if (err instanceof ConfigError) return json(503, { error: 'not-configured' });
    throw err;
  }
}

/** Turns a failure into a plain response. Configuration problems read as "not switched on"; the log keeps the detail. */
export function apiFailure(err: unknown, where: string): Response {
  if (err instanceof ConfigError) {
    console.error(`${where}: ${err.message}`);
    return json(503, { error: 'not-configured' });
  }
  const { status, body } = errorBody(err);
  if (status >= 500 || status === 429) console.error(`${where}: ${(err as Error)?.message ?? String(err)}`);
  return json(status, body);
}

export { json, readJson };

import 'server-only';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { ConfigError, isPreview, sessionEnv } from './env';
import { SESSION_COOKIE, openSession, type StudioSession } from './session-cookie';
import { safeNext } from './redirect';
import { createClient } from './supabase/server';
import type { Viewer } from './types';

/** The sample person in preview mode. */
export const PREVIEW_SESSION: StudioSession = {
  uid: 'preview-user',
  did: 'zns:dev:preview',
  handle: 'ada-lovelace-x7k2',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
};

export const toViewer = (s: StudioSession): Viewer => ({ name: s.name || s.handle, email: s.email, handle: s.handle });

/**
 * Asks Supabase who is signed in. That is a network call, so it is made once per request: the layout, the page and
 * its metadata all share the answer. (The same goes for the session below: one object per request also lets the
 * per-request caches in `data.ts`, which are keyed by it, work across the layout and the page.)
 */
const authUser = cache(async () => (await createClient()).auth.getUser());

/**
 * The signed-in person, or null. Two things must agree: Supabase says who is signed in (revalidated on every
 * request), and Studio's own cookie says that same user has finished the silent setup.
 */
export const getSession = cache(async (): Promise<StudioSession | null> => {
  if (isPreview()) return PREVIEW_SESSION;
  const env = sessionEnv();
  const { data } = await authUser();
  if (!data.user) return null;
  const sealed = openSession((await cookies()).get(SESSION_COOKIE)?.value, env.sessionJwtSecret);
  return sealed && sealed.uid === data.user.id ? sealed : null;
});

/** For pages and server actions: the session, or a redirect to sign in (or to finish setup). */
export async function requireSession(next?: string): Promise<StudioSession> {
  let session: StudioSession | null;
  let signedIn = false;
  try {
    session = await getSession();
    // Signed in with Google but no (or an out-of-date) setup cookie: finish setup instead of asking to sign in again.
    if (!session && !isPreview()) signedIn = Boolean((await authUser()).data.user);
  } catch (err) {
    if (err instanceof ConfigError) redirect('/sign-in?error=config');
    throw err;
  }
  if (session) return session;
  // The page asked for (set by proxy.ts) is where setup should lead back to, whichever of layout or page redirects.
  const asked = next ?? (await headers()).get('x-studio-path');
  redirect(signedIn ? `/auth/setup?next=${encodeURIComponent(safeNext(asked))}` : '/sign-in');
}

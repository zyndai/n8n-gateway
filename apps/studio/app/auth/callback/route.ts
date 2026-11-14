import { NextResponse } from 'next/server';
import { finishSignIn } from '@/lib/finish-sign-in';
import { publicOrigin } from '@/lib/redirect';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/** Google sends the person back here with a one-time code; swap it for a session, then run the silent setup. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const to = (path: string) => NextResponse.redirect(new URL(path, publicOrigin(request)), 303);
  if (url.searchParams.get('error')) return to('/sign-in?error=denied');
  if (!code) return to('/sign-in?error=callback');

  try {
    const { error } = await (await createClient()).auth.exchangeCodeForSession(code);
    if (error) return to('/sign-in?error=callback');
  } catch {
    return to('/sign-in?error=config');
  }
  return finishSignIn(request, url.searchParams.get('next'));
}

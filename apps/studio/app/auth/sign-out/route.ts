import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { isPreview } from '@/lib/env';
import { publicOrigin } from '@/lib/redirect';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isPreview()) {
    await (await createClient()).auth.signOut().catch(() => undefined);
  }
  (await cookies()).delete(SESSION_COOKIE);
  return NextResponse.redirect(new URL('/sign-in', publicOrigin(request)), 303);
}

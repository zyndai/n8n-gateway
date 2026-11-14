// Keeps the Supabase session fresh: it refreshes the sign-in cookies on each page request, so Server Components
// (which cannot set cookies) always see a valid session. It decides nothing else; pages check access themselves.
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isPreview } from '@/lib/env';

export async function proxy(request: NextRequest) {
  // Through a variable so the values are read when the server runs, not inlined at build time.
  const env: Record<string, string | undefined> = process.env;
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (isPreview() || !url || !key) return NextResponse.next();

  // Tell the page shell which page was asked for, so a person who still has to finish setup lands back on it
  // (a layout cannot see its own path). Set from the request itself, never from a header the browser sent.
  const forwarded = new Headers(request.headers);
  forwarded.set('x-studio-path', `${request.nextUrl.pathname}${request.nextUrl.search}`);

  let response = NextResponse.next({ request: { headers: forwarded } });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list) {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request: { headers: forwarded } });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  // getUser() revalidates the token with Supabase (and refreshes it when needed).
  await supabase.auth.getUser().catch(() => undefined);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|zynd.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};

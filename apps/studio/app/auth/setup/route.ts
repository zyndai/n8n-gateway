import { finishSignIn } from '@/lib/finish-sign-in';

export const dynamic = 'force-dynamic';

/** A signed-in person whose setup cookie is missing or old: repeat the (idempotent) setup, then carry on. */
export async function GET(request: Request) {
  return finishSignIn(request, new URL(request.url).searchParams.get('next'));
}

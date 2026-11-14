import 'server-only';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { ConfigError, studioEnv } from './env';
import { createGatewayClient } from './gateway/client';
import { N8nMcp } from './n8n/mcp';
import { createCredential } from './n8n/rest';
import { publicOrigin, safeNext } from './redirect';
import { SESSION_COOKIE, SESSION_MAX_AGE_S, sealSession } from './session-cookie';
import { createClient } from './supabase/server';
import { SetupError, setupUser } from './setup';

/** What Google gave us, as Supabase stores it. */
function googleName(meta: Record<string, unknown> | undefined): string | null {
  const v = meta?.full_name ?? meta?.name;
  return typeof v === 'string' ? v : null;
}

/**
 * After Google, or when the setup cookie is missing: check the Supabase user, run the silent setup (idempotent),
 * remember the result in Studio's cookie and send the person on. Failures go back to the sign-in page with a
 * plain reason, and never show a stack trace.
 */
export async function finishSignIn(request: Request, nextPath: string | null): Promise<NextResponse> {
  const origin = publicOrigin(request);
  const to = (path: string) => NextResponse.redirect(new URL(path, origin), 303);
  try {
    const env = studioEnv();
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    const user = data.user;
    if (!user) return to('/sign-in?error=callback');

    const gateway = createGatewayClient({ baseUrl: env.gatewayUrl, sessionSecret: env.sessionJwtSecret, serviceToken: env.serviceToken });
    const mcp = new N8nMcp({ url: env.n8nMcpUrl, token: env.n8nMcpToken });
    const session = await setupUser(
      {
        gateway,
        n8n: {
          findCredentials: (type, name) => mcp.findCredentials(type, name),
          createCredential: (body) => createCredential({ apiUrl: env.n8nApiUrl, apiKey: env.n8nApiKey }, body),
        },
        gatewayUrlForN8n: env.gatewayUrlForN8n,
        spendCapUsd: env.agentKeySpendCapUsd,
        log: console,
      },
      { id: user.id, name: googleName(user.user_metadata) ?? '', email: user.email ?? '' },
    );

    (await cookies()).set(SESSION_COOKIE, sealSession(session, env.sessionJwtSecret), {
      httpOnly: true,
      secure: origin.startsWith('https://'),
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_S,
    });
    return to(safeNext(nextPath));
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return to('/sign-in?error=config');
    }
    // The step and reason are for the logs; the person sees a plain sentence.
    console.error(err instanceof SetupError ? `sign-in setup failed at "${err.step}": ${err.message}` : `sign-in failed: ${(err as Error).message}`);
    return to('/sign-in?error=setup');
  }
}

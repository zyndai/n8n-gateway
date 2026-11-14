import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Logo } from '@/components/logo';
import { SignInCard } from '@/components/sign-in-card';
import { Card, CardContent } from '@/components/ui/card';
import { copy } from '@/lib/copy';
import { isPreview, sessionEnv } from '@/lib/env';
import { getSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

const messages: Record<string, string> = {
  setup: copy.signIn.errors.setup,
  callback: copy.signIn.errors.callback,
  denied: copy.signIn.errors.denied,
  config: copy.signIn.errors.config,
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const preview = isPreview();
  // Handed to the browser as props so the image does not need them at build time.
  let supabase: { url: string; anonKey: string } | null = null;
  try {
    const env = sessionEnv();
    supabase = { url: env.supabaseUrl, anonKey: env.supabaseAnonKey };
  } catch {
    // Not configured: the card says so.
  }
  // Someone who is already in goes straight to their agents.
  if (!preview && !error && (await getSession().catch(() => null))) redirect('/agents');

  return (
    <main className="flex min-h-screen items-center justify-center bg-secondary/40 px-4 py-12">
      <div className="w-full max-w-[26rem]">
        <div className="mb-8 flex justify-center">
          <Logo href="/sign-in" />
        </div>
        <Card className="shadow-none">
          <CardContent className="space-y-6 px-8 py-4">
            <div className="space-y-2 text-center">
              <h1 className="text-xl font-semibold tracking-tight">{copy.signIn.title}</h1>
              <p className="text-sm leading-6 text-muted-foreground">{copy.signIn.body}</p>
            </div>
            {error ? (
              <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-center text-sm text-destructive">
                {messages[error] ?? copy.errors.generic}
              </p>
            ) : null}
            <SignInCard preview={preview} supabase={supabase} />
            <p className="text-center text-xs leading-5 text-muted-foreground">{preview ? copy.signIn.previewHint : copy.signIn.fine}</p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

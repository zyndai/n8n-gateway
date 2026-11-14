'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { copy } from '@/lib/copy';
import { createClient } from '@/lib/supabase/client';

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.5 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.8V6.5H1.4a12 12 0 0 0 0 11l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.5 1.8l3.4-3.4A12 12 0 0 0 1.4 6.5l4 3.1C6.3 6.9 8.9 4.8 12 4.8z" />
    </svg>
  );
}

export interface SupabasePublic {
  url: string;
  anonKey: string;
}

export function SignInCard({ preview, supabase }: { preview: boolean; supabase: SupabasePublic | null }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function google() {
    setBusy(true);
    setFailed(false);
    if (!supabase) return;
    const { error } = await createClient(supabase.url, supabase.anonKey).auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    // On success the browser is already leaving for Google.
    if (error) {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {preview ? (
        <Button asChild size="lg" className="w-full">
          <Link href="/agents">{copy.signIn.google}</Link>
        </Button>
      ) : !supabase ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-center text-sm text-destructive">
          {copy.signIn.errors.config}
        </p>
      ) : (
        <Button size="lg" variant="outline" className="h-11 w-full border-border bg-background text-[15px] shadow-none" onClick={google} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <GoogleMark />}
          {busy ? copy.signIn.working : copy.signIn.google}
        </Button>
      )}
      {failed ? (
        <p role="alert" className="text-center text-sm text-destructive">
          {copy.signIn.errors.callback}
        </p>
      ) : null}
    </div>
  );
}

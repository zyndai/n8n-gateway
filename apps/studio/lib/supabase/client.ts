import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser client: only used to start the Google sign-in. The address and public key come from the server page
 * as props, not from NEXT_PUBLIC_* variables, so they are read when the container runs and never baked into the image.
 */
export function createClient(url: string, anonKey: string) {
  return createBrowserClient(url, anonKey);
}

// Redirect helpers for the auth routes.

/** Only same-site paths, never `//host` or `https://…`: stops "sign in and get sent to a stranger's site". */
export function safeNext(value: string | null | undefined, fallback = '/agents'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\r\n]/.test(value)) return fallback;
  return value;
}

/**
 * The address people use to reach Studio. Behind the reverse proxy the request URL names the container, so
 * prefer `STUDIO_PUBLIC_URL`, then the proxy's forwarded headers, then the request's own origin.
 */
export function publicOrigin(request: { url: string; headers: { get(name: string): string | null } }, env: Record<string, string | undefined> = process.env): string {
  const configured = env.STUDIO_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (host && /^[a-z0-9.-]+(:\d+)?$/i.test(host)) return `${proto === 'http' || proto === 'https' ? proto : new URL(request.url).protocol.replace(':', '')}://${host}`;
  return new URL(request.url).origin;
}

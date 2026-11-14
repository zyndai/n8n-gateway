import { describe, expect, it } from 'vitest';
import { publicOrigin, safeNext } from '@/lib/redirect';

describe('safeNext', () => {
  it('keeps same-site paths', () => {
    expect(safeNext('/agents/abc?tab=chat')).toBe('/agents/abc?tab=chat');
    expect(safeNext('/agents/new')).toBe('/agents/new');
  });
  it('refuses anything that could leave the site', () => {
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'agents', '', null, undefined, '/ok\r\nSet-Cookie: x=1']) {
      expect(safeNext(bad as string | null)).toBe('/agents');
    }
  });
});

describe('publicOrigin', () => {
  const req = (headers: Record<string, string>) => ({ url: 'http://localhost:3100/auth/callback', headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } });
  it('prefers STUDIO_PUBLIC_URL', () => {
    expect(publicOrigin(req({ host: 'internal:3100' }), { STUDIO_PUBLIC_URL: 'https://studio.example.com/' })).toBe('https://studio.example.com');
  });
  it('uses the proxy headers behind a reverse proxy', () => {
    expect(publicOrigin(req({ 'x-forwarded-host': 'studio.example.com', 'x-forwarded-proto': 'https' }), {})).toBe('https://studio.example.com');
  });
  it('falls back to the request origin and ignores a malformed host', () => {
    expect(publicOrigin(req({}), {})).toBe('http://localhost:3100');
    expect(publicOrigin(req({ 'x-forwarded-host': 'evil.example/path?x', 'x-forwarded-proto': 'https' }), {})).toBe('http://localhost:3100');
  });
});

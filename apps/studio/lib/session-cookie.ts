// Studio's own small cookie: it remembers the result of the silent setup (developer id and handle) so every
// page does not repeat it. It is encrypted and authenticated (AES-256-GCM), and it is never trusted on its own:
// every request also checks the Supabase session and that both name the same user.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'zs_session';
export const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

export interface StudioSession {
  /** Supabase user id. */
  uid: string;
  /** Zynd developer id (`zns:dev:…`). */
  did: string;
  handle: string;
  name: string;
  email: string;
}

interface Sealed extends StudioSession {
  exp: number;
}

/** A key of its own, derived from the Gateway secret, so the cookie never shares a key with the Session JWT. */
function cookieKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'zynd-studio-session-cookie-v1', 32));
}

export function sealSession(session: StudioSession, secret: string, nowMs: number = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cookieKey(secret), iv);
  const body: Sealed = { ...session, exp: Math.floor(nowMs / 1000) + SESSION_MAX_AGE_S };
  const enc = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

/** The session, or null for anything that is not a fresh cookie we sealed. Never throws. */
export function openSession(value: string | undefined, secret: string, nowMs: number = Date.now()): StudioSession | null {
  if (!value) return null;
  try {
    const raw = Buffer.from(value, 'base64url');
    if (raw.length < 12 + 16 + 2) return null;
    const decipher = createDecipheriv('aes-256-gcm', cookieKey(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    const s = JSON.parse(plain) as Partial<Sealed>;
    if (typeof s.exp !== 'number' || s.exp * 1000 < nowMs) return null;
    // The ids must be there; name and email may be empty for some Google accounts.
    if (!s.uid || !s.did || !s.handle || [s.uid, s.did, s.handle].some((v) => typeof v !== 'string')) return null;
    return { uid: s.uid, did: s.did, handle: s.handle, name: String(s.name ?? ''), email: String(s.email ?? '') };
  } catch {
    return null;
  }
}

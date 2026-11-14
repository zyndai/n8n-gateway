import { describe, expect, it } from 'vitest';
import { SESSION_MAX_AGE_S, openSession, sealSession, type StudioSession } from '@/lib/session-cookie';

const SECRET = 'a-session-secret-of-at-least-32-characters!!';
const session: StudioSession = { uid: 'u-1', did: 'zns:dev:abc', handle: 'ada-x7k2', name: 'Ada Lovelace', email: 'ada@example.com' };

describe('session cookie', () => {
  it('round-trips the session', () => {
    expect(openSession(sealSession(session, SECRET), SECRET)).toEqual(session);
  });

  it('does not show its contents', () => {
    const sealed = sealSession(session, SECRET);
    for (const word of ['zns:dev', 'ada-x7k2', 'Ada', 'ada@example.com']) {
      expect(Buffer.from(sealed, 'base64url').toString('utf8')).not.toContain(word);
      expect(sealed).not.toContain(word);
    }
  });

  it('is different every time (fresh IV)', () => {
    expect(sealSession(session, SECRET)).not.toBe(sealSession(session, SECRET));
  });

  it('rejects a cookie sealed with another secret, a changed byte, junk, and nothing', () => {
    const sealed = sealSession(session, SECRET);
    expect(openSession(sealed, 'another-secret-of-at-least-32-characters!!')).toBeNull();
    const raw = Buffer.from(sealed, 'base64url');
    raw[raw.length - 1] = (raw[raw.length - 1] as number) ^ 1;
    expect(openSession(raw.toString('base64url'), SECRET)).toBeNull();
    for (const bad of ['', 'x', 'not base64 at all!', 'AAAA'.repeat(30), undefined]) expect(openSession(bad, SECRET)).toBeNull();
  });

  it('expires after a week', () => {
    const now = Date.UTC(2026, 10, 16);
    const sealed = sealSession(session, SECRET, now);
    expect(openSession(sealed, SECRET, now + (SESSION_MAX_AGE_S - 5) * 1000)).toEqual(session);
    expect(openSession(sealed, SECRET, now + (SESSION_MAX_AGE_S + 5) * 1000)).toBeNull();
  });

  it('keeps a name and email that Google left empty', () => {
    const bare = { ...session, name: '', email: '' };
    expect(openSession(sealSession(bare, SECRET), SECRET)).toEqual(bare);
  });
});

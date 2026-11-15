// The builder conversation lives in OpenAI's stored responses; the browser keeps only a pointer to the last one. The
// pointer is signed for one person and one agent, so nobody can continue someone else's conversation by guessing or
// swapping an id (plan, "Where state lives").
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

const TTL_MS = 29 * 24 * 60 * 60 * 1000; // OpenAI keeps stored responses for 30 days

const key = (secret: string) => Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'zynd-studio-thread-v1', 32));
const mac = (secret: string, uid: string, agentId: string, responseId: string, exp: number) =>
  createHmac('sha256', key(secret)).update(`${uid}\n${agentId}\n${responseId}\n${exp}`).digest('base64url');

export function signThread(secret: string, uid: string, agentId: string, responseId: string, nowMs: number = Date.now()): string {
  const exp = nowMs + TTL_MS;
  return `${responseId}.${exp}.${mac(secret, uid, agentId, responseId, exp)}`;
}

/** The response id inside a token made for this person and agent, or null for anything else. Never throws. */
export function verifyThread(secret: string, uid: string, agentId: string, token: unknown, nowMs: number = Date.now()): string | null {
  if (typeof token !== 'string' || token.length > 400) return null;
  const [responseId, expText, given] = token.split('.');
  const exp = Number(expText);
  if (!responseId || !given || !Number.isFinite(exp) || exp < nowMs) return null;
  const want = Buffer.from(mac(secret, uid, agentId, responseId, exp));
  const got = Buffer.from(given);
  return want.length === got.length && timingSafeEqual(want, got) ? responseId : null;
}

import { createHmac } from 'node:crypto';

export const TEST_SECRET = 'test-session-secret-0123456789abcdef0123456789';

export function mintToken(
  claims: Record<string, unknown>,
  opts: { secret?: string; alg?: string; header?: Record<string, unknown> } = {},
): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: opts.alg ?? 'HS256', typ: 'JWT', ...opts.header });
  const body = enc(claims);
  const sig = createHmac('sha256', opts.secret ?? TEST_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${opts.alg === 'none' ? '' : sig}`;
}

export const inMinutes = (m: number) => Math.floor(Date.now() / 1000) + m * 60;

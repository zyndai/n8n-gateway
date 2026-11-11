// One-line payment logging for `docker logs`. Every payment event is a single `event k=v k=v` line.
//
// Rules this file enforces so call sites cannot get them wrong:
//  - logging never throws and never changes behaviour (everything is wrapped);
//  - a line is never multi-line, and no value is longer than MAX_VALUE;
//  - anything that looks like a signature, a PAYMENT-SIGNATURE blob, a bearer token or a Gateway
//    API key is redacted, even inside a `reason` the remote side wrote. Call sites should not pass
//    secrets in the first place; this is the backstop.
import { formatUsd } from './money.js';

export type PaymentLogger = Pick<Console, 'info' | 'warn' | 'error'>;
export type PaymentLogLevel = 'info' | 'warn' | 'error';
type Field = string | number | boolean | bigint | null | undefined;

const MAX_VALUE = 200;
const REDACTED = '[redacted]';

/** Addresses (42 chars) and tx hashes / nonce prefixes (66) pass; a 65-byte signature (132) does not. */
const LONG_HEX = /0x[0-9a-fA-F]{67,}/g;
/** base64 / base64url blobs such as a PAYMENT-SIGNATURE header or a `zk_` API key. */
const LONG_BLOB = /[A-Za-z0-9+/_=-]{80,}/g; // longer than any tx hash (66)
const BEARER = /\b(bearer|basic)\s+\S+/gi;
const API_KEY = /\bzk_[A-Za-z0-9_-]+/g;

function clean(value: string): string {
  let s = value.replace(/\s+/g, ' ').trim();
  s = s.replace(BEARER, '$1 ' + REDACTED).replace(API_KEY, REDACTED).replace(LONG_HEX, REDACTED).replace(LONG_BLOB, REDACTED);
  if (s.length > MAX_VALUE) s = `${s.slice(0, MAX_VALUE)}...`;
  return /[\s="]/.test(s) || s === '' ? JSON.stringify(s) : s;
}

export function formatLine(event: string, fields: Record<string, Field>): string {
  const parts = [event];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${clean(typeof v === 'string' ? v : String(v))}`);
  }
  return parts.join(' ');
}

/** Write one payment line. Never throws: a broken logger must not fail a payment. */
export function logPayment(log: PaymentLogger | undefined, level: PaymentLogLevel, event: string, fields: Record<string, Field> = {}): void {
  try {
    log?.[level](formatLine(event, fields));
  } catch {
    /* logging is best effort */
  }
}

/** micro-USD for a log line: `0.05`, `1.00`, `0.000001` (trailing zeros trimmed, at least 2 decimals). */
export function usd(micro: bigint | undefined): string | undefined {
  if (micro === undefined) return undefined;
  try {
    const [whole = '0', frac = ''] = formatUsd(micro).split('.');
    return `${whole}.${frac.replace(/0+$/, '').padEnd(2, '0')}`;
  } catch {
    return undefined;
  }
}

/** First 10 characters of an EIP-3009 nonce: enough to tell a replay apart, not a secret. */
export const nonceHead = (nonce: string | undefined): string | undefined => nonce?.slice(0, 10);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Why a remote x402 server said no, from its response body. Looks at the shapes seen in practice:
 * `{error: "..."}`, `{error: {message, data: {details: {reason}}}}` (this Gateway), `{reason}`.
 */
export function reasonFromBody(json: unknown): string | undefined {
  if (!isObj(json)) return undefined;
  const e = json.error;
  if (typeof e === 'string') return e;
  if (isObj(e)) {
    const data = isObj(e.data) ? e.data : undefined;
    const details = isObj(data?.details) ? data.details : undefined;
    return text(details?.reason) ?? text(e.reason) ?? text(e.message);
  }
  return text(json.reason) ?? text(json.message);
}

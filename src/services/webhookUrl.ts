// Guard for user-supplied webhook URLs: the Gateway will POST jobs (with a secret) to whatever
// is stored, so a hostile URL must not be able to reach the Gateway's own network.
// This checks the literal host only; it does not defend against DNS names that resolve to
// private addresses (rebinding). Production should also restrict egress at the network layer.
import { isIP } from 'node:net';
import { ApiError } from '../errors.js';

function privateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function privateV6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === '::1' || h === '::') return true;
  // IPv4-mapped (::ffff:a.b.c.d). The URL parser rewrites it to hex groups (::ffff:a00:1), so handle both.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) return privateV4(dotted[1] as string);
  const hexed = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hexed) {
    const hi = parseInt(hexed[1] as string, 16);
    const lo = parseInt(hexed[2] as string, 16);
    return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
}

export function assertWebhookUrl(raw: unknown, opts: { allowPrivate: boolean }): string {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) throw new ApiError('BAD_REQUEST', 'url must be a string of at most 2048 characters');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError('BAD_REQUEST', 'url is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ApiError('BAD_REQUEST', 'url must be http or https');
  if (url.username || url.password) throw new ApiError('BAD_REQUEST', 'url must not contain credentials');
  if (!opts.allowPrivate) {
    if (url.protocol !== 'https:') throw new ApiError('BAD_REQUEST', 'url must be https');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const kind = isIP(host);
    const blocked =
      (kind === 4 && privateV4(host)) ||
      (kind === 6 && privateV6(host)) ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal');
    if (blocked) throw new ApiError('BAD_REQUEST', 'url must not point at a private or loopback address');
  }
  return url.toString();
}

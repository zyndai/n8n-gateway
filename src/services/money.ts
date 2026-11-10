// Decimal USD <-> integer units, without floats. USD amounts are decimal strings with up to
// 6 decimals (matches the numeric(18,6) columns); token amounts are bigint atomic units.
import { ApiError } from '../errors.js';

const MICRO = 6;
const USD_RE = /^\d{1,12}(\.\d{1,6})?$/;

/** "0.05" -> 50000n micro-USD. Rejects negatives, exponents and more than 6 decimals. */
export function parseUsd(value: string | number, field = 'amount'): bigint {
  const s = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(MICRO) : '') : value.trim();
  if (!USD_RE.test(s)) throw new ApiError('BAD_REQUEST', `${field} must be a non-negative USD amount with at most 6 decimals`);
  const [whole = '0', frac = ''] = s.split('.');
  return BigInt(whole) * 10n ** BigInt(MICRO) + BigInt(frac.padEnd(MICRO, '0'));
}

/** 50000n -> "0.050000" (always 6 decimals, the Postgres numeric(18,6) text form). */
export function formatUsd(micro: bigint): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const base = 10n ** BigInt(MICRO);
  return `${neg ? '-' : ''}${abs / base}.${(abs % base).toString().padStart(MICRO, '0')}`;
}

/** Token atomic units (e.g. USDC with 6 decimals) -> micro-USD, rounding up so a cap is never undercounted. */
export function atomicToMicroUsd(atomic: bigint, decimals: number): bigint {
  if (decimals === MICRO) return atomic;
  if (decimals < MICRO) return atomic * 10n ** BigInt(MICRO - decimals);
  const div = 10n ** BigInt(decimals - MICRO);
  return (atomic + div - 1n) / div;
}

/** micro-USD -> token atomic units. Exact for decimals >= 6. */
export function microUsdToAtomic(micro: bigint, decimals: number): bigint {
  if (decimals >= MICRO) return micro * 10n ** BigInt(decimals - MICRO);
  return micro / 10n ** BigInt(MICRO - decimals);
}

/**
 * G17: what one inbound call costs. A listing's own price wins; null falls back to the Gateway
 * default (`X402_INBOUND_PRICE_USD`). Returns undefined when the call is free (no price, or zero).
 */
export function effectivePriceUsd(listingPrice: string | null | undefined, defaultPrice: string | undefined): string | undefined {
  const price = listingPrice ?? defaultPrice;
  if (price === undefined || price === '') return undefined;
  return parseUsd(price, 'price') === 0n ? undefined : price;
}

/**
 * Deterministic JSON canonicalisation for signing: sorted keys (UTF-16 code unit order), no
 * whitespace, ECMAScript number formatting. Byte-identical to the TS SDK's `canonicalJson`
 * (zyndai-ts-sdk/src/a2a/canonical.ts) and to AgentDNS's Go `models.CanonicalJSON` for the
 * envelope shapes Zynd uses (ASCII/BMP strings, no NaN/Infinity). Reused for `x-zynd-auth` in M2.6.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number: ${value}`);
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported value type: ${typeof value}`);
  }
}

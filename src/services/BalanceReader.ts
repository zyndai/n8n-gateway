// USD balance of an address, read from the payment token (USDC by default) with one JSON-RPC
// batch of `balanceOf` calls. A balance that cannot be read is null: the wallet view must never
// fail because a public RPC node is slow.
import { atomicToMicroUsd, formatUsd } from './money.js';

const BALANCE_OF = '0x70a08231'; // balanceOf(address)

/** Public RPC endpoints for the networks the Gateway knows; anything else needs X402_RPC_URL. */
const DEFAULT_RPC: Record<string, string> = {
  'eip155:84532': 'https://sepolia.base.org',
  'eip155:8453': 'https://mainnet.base.org',
};

export const defaultRpcUrl = (network: string): string | undefined => DEFAULT_RPC[network];

export interface BalanceReaderLike {
  /** Decimal USD with 6 decimals per address, or null when it could not be read. */
  balances(addresses: string[]): Promise<Map<string, string | null>>;
}

export interface BalanceReaderOptions {
  rpcUrl: string | undefined;
  /** Token contract. */
  asset: string;
  decimals: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  log?: Pick<Console, 'warn'>;
}

export class UsdBalanceReader implements BalanceReaderLike {
  private readonly cache = new Map<string, { at: number; value: string | null }>();

  constructor(private readonly o: BalanceReaderOptions) {}

  async balances(addresses: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const now = (this.o.now ?? Date.now)();
    const ttl = this.o.ttlMs ?? 10_000;
    const missing: string[] = [];
    for (const a of new Set(addresses)) {
      const hit = this.cache.get(a.toLowerCase());
      if (hit && now - hit.at < ttl) out.set(a, hit.value);
      else missing.push(a);
    }
    if (missing.length === 0) return out;

    const fetched = await this.fetchBalances(missing);
    for (const a of missing) {
      const value = fetched.get(a) ?? null;
      out.set(a, value);
      // A failure is cached for a shorter spell (one ttl) too, so a down RPC is not hammered.
      this.cache.set(a.toLowerCase(), { at: now, value });
    }
    return out;
  }

  private async fetchBalances(addresses: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!this.o.rpcUrl) return result;
    const batch = addresses.map((address, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'eth_call',
      params: [{ to: this.o.asset, data: `${BALANCE_OF}${'0'.repeat(24)}${address.slice(2).toLowerCase()}` }, 'latest'],
    }));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 4_000);
    try {
      const res = await (this.o.fetchImpl ?? fetch)(this.o.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const body = (await res.json()) as { id: number; result?: string }[] | { id: number; result?: string };
      for (const item of Array.isArray(body) ? body : [body]) {
        const address = addresses[item.id];
        if (address === undefined || typeof item.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(item.result)) continue;
        result.set(address, formatUsd(atomicToMicroUsd(BigInt(item.result), this.o.decimals)));
      }
    } catch (e) {
      (this.o.log ?? console).warn(`balance lookup failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    return result;
  }
}

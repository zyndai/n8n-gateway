import { describe, expect, it } from 'vitest';
import { UsdBalanceReader, defaultRpcUrl } from '../src/services/BalanceReader.js';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

function rpc(results: Record<string, string>) {
  const calls: { url: string; body: { id: number; params: [{ to: string; data: string }] }[] }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, body });
    const out = body.map((r: { id: number; params: [{ data: string }] }) => {
      const result = results[`0x${r.params[0].data.slice(-40)}`];
      return result ? { jsonrpc: '2.0', id: r.id, result } : { jsonrpc: '2.0', id: r.id, error: { code: -1, message: 'x' } };
    });
    return new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('UsdBalanceReader', () => {
  it('reads token balances in one batch and returns decimal USD', async () => {
    const { fetchImpl, calls } = rpc({ [A]: '0x' + (2_500_000).toString(16), [B]: '0x0' });
    const r = new UsdBalanceReader({ rpcUrl: 'http://rpc', asset: ASSET, decimals: 6, fetchImpl });
    const out = await r.balances([A, B]);
    expect(out.get(A)).toBe('2.500000');
    expect(out.get(B)).toBe('0.000000');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body[0]!.params[0]).toEqual({ to: ASSET, data: `0x70a08231${'0'.repeat(24)}${A.slice(2)}` });
  });

  it('answers null for an address the node failed on, and for everything when it is down', async () => {
    const { fetchImpl } = rpc({ [A]: '0x1' });
    const ok = await new UsdBalanceReader({ rpcUrl: 'http://rpc', asset: ASSET, decimals: 6, fetchImpl }).balances([A, B]);
    expect(ok.get(A)).toBe('0.000001');
    expect(ok.get(B)).toBeNull();

    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const warnings: string[] = [];
    const out = await new UsdBalanceReader({ rpcUrl: 'http://rpc', asset: ASSET, decimals: 6, fetchImpl: down, log: { warn: (m: string) => void warnings.push(m) } }).balances([A]);
    expect(out.get(A)).toBeNull();
    expect(warnings[0]).toMatch(/ECONNREFUSED/);
  });

  it('is null without an RPC url, and caches for the ttl', async () => {
    expect((await new UsdBalanceReader({ rpcUrl: undefined, asset: ASSET, decimals: 6 }).balances([A])).get(A)).toBeNull();

    const { fetchImpl, calls } = rpc({ [A]: '0x5' });
    let t = 1_000;
    const r = new UsdBalanceReader({ rpcUrl: 'http://rpc', asset: ASSET, decimals: 6, fetchImpl, now: () => t, ttlMs: 10_000 });
    await r.balances([A]);
    await r.balances([A]);
    expect(calls).toHaveLength(1);
    t += 10_001;
    await r.balances([A]);
    expect(calls).toHaveLength(2);
  });

  it('knows the public Base nodes', () => {
    expect(defaultRpcUrl('eip155:84532')).toBe('https://sepolia.base.org');
    expect(defaultRpcUrl('eip155:1')).toBeUndefined();
  });
});

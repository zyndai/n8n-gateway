import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, parseTransaction, type Hex } from 'viem';
import { createTreasury, sendStarterCredit, type Treasury } from '@/lib/credit/starter';
import type { CreditEnv } from '@/lib/env';

const WALLET = '0xB95a35B8847Ba20e5f2F55e3391fE4fC585Ec5D6';
const log = { info: () => {}, warn: () => {} };

const fakeTreasury = (over: Partial<Treasury> = {}): Treasury & { sent: [string, string][] } => {
  const t = {
    sent: [] as [string, string][],
    balanceUsd: async () => '50',
    send: async (to: string, amount: string) => {
      t.sent.push([to, amount]);
      return '0xhash';
    },
    ...over,
  };
  return t;
};
const req = (over: Partial<Parameters<typeof sendStarterCredit>[0]> = {}) => ({ treasury: fakeTreasury(), amountUsd: '1', maxAgents: 3, agentNumber: 1, walletAddress: WALLET, log, ...over });

describe('sendStarterCredit', () => {
  it('sends the credit to the new agent\'s wallet', async () => {
    const treasury = fakeTreasury();
    expect(await sendStarterCredit(req({ treasury }))).toEqual({ status: 'sent', amountUsd: '1', txHash: '0xhash' });
    expect(treasury.sent).toEqual([[WALLET, '1']]);
  });
  it('only for a person\'s first agents', async () => {
    const treasury = fakeTreasury();
    expect((await sendStarterCredit(req({ treasury, agentNumber: 3 }))).status).toBe('sent');
    expect(await sendStarterCredit(req({ treasury, agentNumber: 4 }))).toEqual({ status: 'skipped', reason: 'limit' });
    expect(treasury.sent).toHaveLength(1);
  });
  it('is skipped, not an error, when there is no platform wallet or no agent wallet yet', async () => {
    expect(await sendStarterCredit(req({ treasury: null }))).toEqual({ status: 'skipped', reason: 'not-configured' });
    expect(await sendStarterCredit(req({ walletAddress: undefined }))).toEqual({ status: 'skipped', reason: 'no-wallet' });
    expect(await sendStarterCredit(req({ walletAddress: 'not-an-address' }))).toEqual({ status: 'skipped', reason: 'no-wallet' });
  });
  it('is skipped when the platform wallet is low, and sends nothing', async () => {
    const treasury = fakeTreasury({ balanceUsd: async () => '0.40' });
    expect(await sendStarterCredit(req({ treasury }))).toEqual({ status: 'skipped', reason: 'low-balance' });
    expect(treasury.sent).toEqual([]);
  });
  it('reports a failed transfer without throwing, with the first line only', async () => {
    const treasury = fakeTreasury({ send: async () => Promise.reject(new Error('insufficient funds for gas\nstack trace...')) });
    expect(await sendStarterCredit(req({ treasury }))).toEqual({ status: 'failed', message: 'insufficient funds for gas' });
    const unreadable = fakeTreasury({ balanceUsd: async () => Promise.reject(new Error('rpc down')) });
    expect((await sendStarterCredit(req({ treasury: unreadable }))).status).toBe('failed');
  });
});

/** A chain that answers just enough JSON-RPC for one ERC-20 transfer, and keeps the signed transaction. */
class FakeChain {
  server: Server;
  url = '';
  raw: Hex[] = [];
  balance = 5_000_000n; // 5 aUSD
  methods: string[] = [];
  constructor() {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const rpc = JSON.parse(body) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
        const one = (r: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: '2.0', id: r.id, result: this.answer(r.method, r.params) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(Array.isArray(rpc) ? rpc.map(one) : one(rpc)));
      });
    });
  }
  answer(method: string, params: unknown[]): unknown {
    this.methods.push(method);
    switch (method) {
      case 'eth_chainId':
        return '0x14a34';
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_estimateGas':
        return '0xc350';
      case 'eth_maxPriorityFeePerGas':
        return '0x3b9aca00';
      case 'eth_gasPrice':
        return '0x59682f00';
      case 'eth_getBlockByNumber':
        return { number: '0x10', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'00'.repeat(32)}`, baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x65000000', transactions: [], miner: `0x${'00'.repeat(20)}`, nonce: '0x0000000000000000', difficulty: '0x0', totalDifficulty: '0x0', sha3Uncles: `0x${'00'.repeat(32)}`, logsBloom: `0x${'00'.repeat(256)}`, transactionsRoot: `0x${'00'.repeat(32)}`, stateRoot: `0x${'00'.repeat(32)}`, receiptsRoot: `0x${'00'.repeat(32)}`, extraData: '0x', size: '0x1', uncles: [] };
      case 'eth_call':
        return `0x${this.balance.toString(16).padStart(64, '0')}`;
      case 'eth_sendRawTransaction':
        this.raw.push(params[0] as Hex);
        return `0x${'ab'.repeat(32)}`;
      case 'eth_getTransactionReceipt':
        return { transactionHash: `0x${'ab'.repeat(32)}`, transactionIndex: '0x0', blockHash: `0x${'11'.repeat(32)}`, blockNumber: '0x11', from: `0x${'00'.repeat(20)}`, to: `0x${'00'.repeat(20)}`, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', contractAddress: null, logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', effectiveGasPrice: '0x3b9aca00', type: '0x2' };
      default:
        return null;
    }
  }
  async listen() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  close() {
    this.server.close();
  }
}

describe('createTreasury against a chain', () => {
  let chain: FakeChain | undefined;
  afterEach(() => chain?.close());
  const cfg = (url: string): CreditEnv => ({ treasuryKey: `0x${'1'.repeat(64)}`, rpcUrl: url, chainId: 84532, asset: '0xbeA34973e5f67F18F656A2C6070C64326C791808', decimals: 6, amountUsd: '1', maxAgents: 3 });

  it('sends a signed ERC-20 transfer of exactly the credit to exactly the agent wallet', async () => {
    chain = new FakeChain();
    await chain.listen();
    const t = createTreasury(cfg(chain.url));
    expect(await t.balanceUsd()).toBe('5');
    const hash = await t.send(WALLET, '1.25');
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(chain.raw).toHaveLength(1);
    const tx = parseTransaction(chain.raw[0] as Hex);
    expect(tx.to?.toLowerCase()).toBe('0xbea34973e5f67f18f656a2c6070c64326c791808');
    expect(tx.chainId).toBe(84532);
    expect(tx.value ?? 0n).toBe(0n);
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex });
    expect(call.functionName).toBe('transfer');
    expect((call.args?.[0] as string).toLowerCase()).toBe(WALLET.toLowerCase());
    expect(call.args?.[1]).toBe(1_250_000n);
  });

  it('works through sendStarterCredit, and sends two credits one after the other', async () => {
    chain = new FakeChain();
    await chain.listen();
    const t = createTreasury(cfg(chain.url));
    const [a, b] = await Promise.all([sendStarterCredit(req({ treasury: t })), sendStarterCredit(req({ treasury: t, agentNumber: 2 }))]);
    expect([a.status, b.status]).toEqual(['sent', 'sent']);
    expect(chain.raw).toHaveLength(2);
  });

  it('is skipped when the wallet cannot cover it', async () => {
    chain = new FakeChain();
    chain.balance = 500_000n; // 0.50
    await chain.listen();
    expect(await sendStarterCredit(req({ treasury: createTreasury(cfg(chain.url)) }))).toEqual({ status: 'skipped', reason: 'low-balance' });
    expect(chain.raw).toEqual([]);
  });
});

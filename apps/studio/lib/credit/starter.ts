// Starter credit (S2.1): when a person creates one of their first few agents, the platform wallet sends that agent's
// wallet a little test aUSD so it can hire helpers straight away. Sends are serialised (one platform key, one nonce
// at a time), and a platform wallet that is low is a plain "skipped", never an error that stops the agent being made.
import { createPublicClient, createWalletClient, erc20Abi, getAddress, http, isAddress, parseUnits, formatUnits, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { CreditEnv } from '../env';

export interface Treasury {
  /** Sends `amountUsd` of the token to `to` and resolves with the transaction hash. */
  send(to: string, amountUsd: string): Promise<string>;
  /** What the platform wallet holds, USD (a decimal string). */
  balanceUsd(): Promise<string>;
}

export type StarterOutcome =
  | { status: 'sent'; amountUsd: string; txHash: string }
  /** No credit was due, or the platform could not afford it. The agent is still created. */
  | { status: 'skipped'; reason: 'not-configured' | 'limit' | 'low-balance' | 'no-wallet' }
  | { status: 'failed'; message: string };

export function createTreasury(cfg: CreditEnv): Treasury {
  const chain: Chain = {
    id: cfg.chainId,
    name: `chain-${cfg.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  };
  const account = privateKeyToAccount((cfg.treasuryKey.startsWith('0x') ? cfg.treasuryKey : `0x${cfg.treasuryKey}`) as Hex);
  const transport = http(cfg.rpcUrl, { timeout: 15_000, retryCount: 1 });
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const token = getAddress(cfg.asset);

  // One transaction at a time, so two people creating agents together never reuse a nonce.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    balanceUsd: async () => {
      const raw = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
      return formatUnits(raw, cfg.decimals);
    },
    send: (to, amountUsd) =>
      serial(async () => {
        const hash = await wallet.writeContract({
          address: token,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [getAddress(to), parseUnits(amountUsd, cfg.decimals)],
        });
        // Wait for the first confirmation so the new agent shows its credit; a slow chain is not a failure.
        await pub.waitForTransactionReceipt({ hash, timeout: 30_000 }).catch(() => undefined);
        return hash;
      }),
  };
}

export interface StarterRequest {
  treasury: Treasury | null;
  amountUsd: string;
  maxAgents: number;
  /** How many agents the person has once this one exists (this one included). */
  agentNumber: number;
  /** The new agent's wallet address, from the Gateway's wallet view. */
  walletAddress: string | undefined;
  log?: Pick<Console, 'info' | 'warn'>;
}

/** Sends starter credit when it is due. Never throws. */
export async function sendStarterCredit(req: StarterRequest): Promise<StarterOutcome> {
  if (!req.treasury) return { status: 'skipped', reason: 'not-configured' };
  if (req.agentNumber > req.maxAgents) return { status: 'skipped', reason: 'limit' };
  if (!req.walletAddress || !isAddress(req.walletAddress)) return { status: 'skipped', reason: 'no-wallet' };
  try {
    const balance = Number(await req.treasury.balanceUsd());
    if (!Number.isFinite(balance) || balance < Number(req.amountUsd)) {
      req.log?.warn(`starter credit: platform wallet is low (${balance}), skipped`);
      return { status: 'skipped', reason: 'low-balance' };
    }
    const txHash = await req.treasury.send(req.walletAddress, req.amountUsd);
    req.log?.info(`starter credit: sent ${req.amountUsd} to ${req.walletAddress} (${txHash})`);
    return { status: 'sent', amountUsd: req.amountUsd, txHash };
  } catch (err) {
    // Out of gas money, a dead RPC, a refused transfer: the agent still exists, the person just starts without credit.
    const message = err instanceof Error ? err.message.split('\n')[0]?.slice(0, 200) ?? 'transfer failed' : 'transfer failed';
    req.log?.warn(`starter credit: failed for ${req.walletAddress}: ${message}`);
    return { status: 'failed', message };
  }
}

// M4.10 (G10, G21): the EVM wallets behind a developer's money flows.
//   - `payer`: signs outbound x402 payments (derived from the developer's master seed, not stored).
//   - `listings[]`: one wallet per agent. Created with the listing and stored in `n8n_agent_wallet`
//     with its private key encrypted; the address shown is computed from that stored key.
// Only checksummed public addresses and USD balances leave this service, never key material.
import { fromHex, hex, privateKeyToAddress } from './evm.js';
import type { AgentWalletRow, AgentWalletStoreLike } from './AgentWalletStore.js';
import type { BalanceReaderLike } from './BalanceReader.js';
import type { IdentityService } from './IdentityService.js';
import type { ListingStoreLike } from './ListingStore.js';
import type { PaymentProcessor } from './PaymentProcessor.js';
import { decryptSecret, encryptSecret } from './keyVault.js';

export interface WalletView {
  payer: string;
  /** Decimal USD (6 decimals), or null when the chain could not be reached. */
  payerBalanceUsd: string | null;
  listings: { listingId: string; name: string; address: string; balanceUsd: string | null }[];
}

export interface ListingWalletRef {
  id: string;
  developerId: string;
  derivedKeyIndex: number;
}

export interface WalletServiceDeps {
  store: Pick<ListingStoreLike, 'listByDeveloper'>;
  wallets: AgentWalletStoreLike;
  identity: Pick<IdentityService, 'withDeveloperKeypair' | 'getListingKeypair'>;
  payments: Pick<PaymentProcessor, 'evmAddress' | 'deriveEvmKey'>;
  masterKey: Buffer;
  balances: BalanceReaderLike;
}

export class WalletService {
  constructor(private readonly deps: WalletServiceDeps) {}

  /** The address of a stored wallet, computed from its private key. */
  private addressOf(row: AgentWalletRow): string {
    const key = fromHex(decryptSecret(row.privateKeyEnc, this.deps.masterKey));
    try {
      return privateKeyToAddress(key);
    } finally {
      key.fill(0);
    }
  }

  /**
   * Make sure the listing has a stored wallet and return its address. Called when a listing is
   * created, and again from `forDeveloper` for listings that predate the table (same key, so the
   * address does not change). Safe to call twice at once.
   */
  async ensureListingWallet(listing: ListingWalletRef): Promise<string> {
    const { wallets, identity, payments, masterKey } = this.deps;
    const existing = (await wallets.getByListingIds([listing.id])).get(listing.id);
    if (existing) return this.addressOf(existing);

    const agent = await identity.getListingKeypair({ listingId: listing.id, developerId: listing.developerId, derivedKeyIndex: listing.derivedKeyIndex });
    const key = payments.deriveEvmKey(agent.privateKey);
    try {
      const row = await wallets.put({
        listingId: listing.id,
        developerId: listing.developerId,
        derivedKeyIndex: listing.derivedKeyIndex,
        address: privateKeyToAddress(key),
        privateKeyEnc: encryptSecret(hex(key), masterKey),
      });
      return this.addressOf(row);
    } finally {
      key.fill(0);
    }
  }

  async forDeveloper(developerId: string): Promise<WalletView> {
    const { store, wallets, identity, payments, balances } = this.deps;
    const payer = await identity.withDeveloperKeypair(developerId, (dev) => payments.evmAddress(dev.privateKey));
    const rows = await store.listByDeveloper(developerId);
    const stored = await wallets.getByListingIds(rows.map((r) => r.listing.id));
    const addresses = await Promise.all(
      rows.map(({ listing }) => {
        const row = stored.get(listing.id);
        return row ? this.addressOf(row) : this.ensureListingWallet({ id: listing.id, developerId, derivedKeyIndex: listing.derivedKeyIndex });
      }),
    );
    const usd = await balances.balances([payer, ...addresses]);
    return {
      payer,
      payerBalanceUsd: usd.get(payer) ?? null,
      listings: rows.map(({ listing }, i) => ({
        listingId: listing.id,
        name: listing.name,
        address: addresses[i] as string,
        balanceUsd: usd.get(addresses[i] as string) ?? null,
      })),
    };
  }
}

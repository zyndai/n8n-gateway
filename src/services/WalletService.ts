// M4.10 (G10): the EVM addresses behind a developer's money flows. Nothing secret leaves here:
// only checksummed public addresses.
//   - `payer`: signs outbound x402 payments (derived from the developer's master seed).
//   - `listings[].address`: receives inbound payments for that listing (derived from its own seed).
import type { IdentityService } from './IdentityService.js';
import type { ListingStoreLike } from './ListingStore.js';
import type { PaymentProcessor } from './PaymentProcessor.js';

export interface WalletView {
  payer: string;
  listings: { listingId: string; name: string; address: string }[];
}

export class WalletService {
  constructor(
    private readonly deps: {
      store: Pick<ListingStoreLike, 'listByDeveloper'>;
      identity: Pick<IdentityService, 'withDeveloperKeypair' | 'getListingKeypair'>;
      payments: Pick<PaymentProcessor, 'evmAddress'>;
    },
  ) {}

  async forDeveloper(developerId: string): Promise<WalletView> {
    const { store, identity, payments } = this.deps;
    const payer = await identity.withDeveloperKeypair(developerId, (dev) => payments.evmAddress(dev.privateKey));
    const rows = await store.listByDeveloper(developerId);
    const listings = await Promise.all(
      rows.map(async ({ listing }) => {
        const kp = await identity.getListingKeypair({ listingId: listing.id, developerId, derivedKeyIndex: listing.derivedKeyIndex });
        return { listingId: listing.id, name: listing.name, address: payments.evmAddress(kp.privateKey) };
      }),
    );
    return { payer, listings };
  }
}

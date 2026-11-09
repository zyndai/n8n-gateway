// M1.6: listing lifecycle (LLD > N8nListing > status): DRAFT -> REGISTERING -> ACTIVE / INACTIVE / ERROR.
// Pure table here; ListingStore applies it as a compare-and-set UPDATE so two concurrent
// activations cannot both win.
export type ListingStatus = 'DRAFT' | 'REGISTERING' | 'ACTIVE' | 'INACTIVE' | 'ERROR';

export const LISTING_STATUSES: readonly ListingStatus[] = ['DRAFT', 'REGISTERING', 'ACTIVE', 'INACTIVE', 'ERROR'];

const TRANSITIONS: Record<ListingStatus, readonly ListingStatus[]> = {
  DRAFT: ['REGISTERING'],
  // Registration either completes or fails.
  REGISTERING: ['ACTIVE', 'ERROR'],
  // Deactivated by the developer, or registration/heartbeat setup failed afterwards.
  ACTIVE: ['INACTIVE', 'ERROR'],
  // Re-activate an already-registered listing straight to ACTIVE, or re-register from scratch.
  INACTIVE: ['ACTIVE', 'REGISTERING'],
  // Retry registration, or give up.
  ERROR: ['REGISTERING', 'INACTIVE'],
};

export function canTransition(from: ListingStatus, to: ListingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses from which `to` may be entered. */
export function allowedFrom(to: ListingStatus): ListingStatus[] {
  return LISTING_STATUSES.filter((from) => canTransition(from, to));
}

/** A REGISTERING listing older than this is treated as abandoned (the process died mid-registration). */
export const REGISTERING_STALE_MS = 2 * 60_000;

import { describe, expect, it } from 'vitest';
import { LISTING_STATUSES, allowedFrom, canTransition, type ListingStatus } from '../src/services/listingState.js';

// M1.6: every (from, to) pair, so adding or removing an edge is a deliberate test change.
const allowed: Record<ListingStatus, ListingStatus[]> = {
  DRAFT: ['REGISTERING'],
  REGISTERING: ['ACTIVE', 'ERROR'],
  ACTIVE: ['INACTIVE', 'ERROR'],
  INACTIVE: ['ACTIVE', 'REGISTERING'],
  ERROR: ['REGISTERING', 'INACTIVE'],
};

describe('listing state machine (M1.6)', () => {
  for (const from of LISTING_STATUSES) {
    for (const to of LISTING_STATUSES) {
      const ok = allowed[from].includes(to);
      it(`${from} -> ${to} is ${ok ? 'allowed' : 'rejected'}`, () => {
        expect(canTransition(from, to)).toBe(ok);
      });
    }
  }

  it('allowedFrom is the inverse of canTransition', () => {
    expect(allowedFrom('ACTIVE').sort()).toEqual(['INACTIVE', 'REGISTERING']);
    expect(allowedFrom('DRAFT')).toEqual([]);
    expect(allowedFrom('REGISTERING').sort()).toEqual(['DRAFT', 'ERROR', 'INACTIVE']);
  });
});

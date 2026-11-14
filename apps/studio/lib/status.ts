import type { AgentStatus } from './types';

/** The Gateway listing statuses, in the words of the UI: Draft, Live or Paused. */
export function agentStatus(listingStatus: string): AgentStatus {
  switch (listingStatus) {
    case 'ACTIVE':
      return 'live';
    case 'INACTIVE':
    case 'ERROR':
      return 'paused';
    default:
      // DRAFT, and REGISTERING (on its way live) both read as a draft until it is live.
      return 'draft';
  }
}

/** Listings built by Studio carry this tag; it is how "my agents" is found without a database. */
export const STUDIO_TAG = 'zynd-studio';

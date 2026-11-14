'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * What this browser kept under `key`: a string, or null when nothing is there (or no key was asked for). Returns
 * `undefined` while the page is still being server-rendered or hydrated, so the first client render matches the
 * server's and a restored chat appears right after without a mismatch.
 */
export function useStoredText(key: string | null): string | null | undefined {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (key === null) return null;
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null; // storage blocked: the chat simply starts fresh
      }
    },
    () => (key === null ? null : undefined),
  );
}

import { startupWarnings } from './lib/env';

/** Runs once when the server starts. */
export function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  for (const warning of startupWarnings()) console.warn(`studio: ${warning}`);
}

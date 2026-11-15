// First sign-in, silently (plan, "Flows" 1): a Zynd developer identity, an API key for it, and a "Zynd" credential
// in n8n that holds the key. All three are idempotent: signing in again creates nothing new.
import { type GatewayClient, GatewayError } from './gateway/client';
import type { N8nError } from './n8n/rest';
import type { StudioSession } from './session-cookie';
import { randomBytes } from 'node:crypto';

export const KEY_NAME = 'Zynd Studio';
export const CREDENTIAL_TYPE = 'zyndApi';

export interface SetupDeps {
  gateway: GatewayClient;
  n8n: {
    findCredentials(type: string, name: string): Promise<{ id: string }[]>;
    createCredential(body: { name: string; type: string; data: Record<string, string> }): Promise<{ id: string }>;
  };
  /** Gateway address n8n should use, and the spend cap for the user's key. */
  gatewayUrlForN8n: string;
  spendCapUsd: string;
  log?: Pick<Console, 'info' | 'warn'>;
}

export interface SetupUser {
  id: string;
  name: string;
  email: string;
}

/** Setup could not finish. The message is safe to log; the UI shows its own plain words. */
export class SetupError extends Error {
  constructor(
    message: string,
    readonly step: 'identity' | 'key' | 'credential',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SetupError';
  }
}

export const credentialName = (handle: string) => `Zynd · ${handle}`;

/** The name Google gives, or the first part of the email, or a neutral fallback. */
export function displayName(user: { name?: string | null; email?: string | null }): string {
  return user.name?.trim() || user.email?.split('@')[0]?.trim() || 'Zynd Studio user';
}

const inFlight = new Map<string, Promise<StudioSession>>();

/** One setup per user at a time, so a double click cannot create two keys. */
export function setupUser(deps: SetupDeps, user: SetupUser): Promise<StudioSession> {
  const running = inFlight.get(user.id);
  if (running) return running;
  const p = runSetup(deps, user).finally(() => inFlight.delete(user.id));
  inFlight.set(user.id, p);
  return p;
}

async function runSetup(deps: SetupDeps, user: SetupUser): Promise<StudioSession> {
  const { gateway, n8n, log } = deps;
  const name = displayName(user);

  let dev;
  try {
    dev = await gateway.provision(user.id, name);
  } catch (err) {
    throw new SetupError(`could not provision a developer: ${(err as Error).message}`, 'identity', { cause: err });
  }
  const session: StudioSession = { uid: user.id, did: dev.developerId, handle: dev.handle, name: dev.name || name, email: user.email };

  const credName = credentialName(dev.handle);
  let existing;
  try {
    existing = await n8n.findCredentials(CREDENTIAL_TYPE, credName);
  } catch (err) {
    throw new SetupError(`could not look for the n8n credential: ${(err as Error).message}`, 'credential', { cause: err });
  }
  if (existing.length > 0) return session;

  // No credential yet: it needs a key whose plaintext we hold. An earlier attempt may have left a key without a
  // credential; its plaintext is gone, so replace it (rotate with no grace) instead of piling up keys.
  const api = gateway.as(dev.developerId);
  let created;
  try {
    const keys = await api.listApiKeys();
    const old = keys.find((k) => k.name === KEY_NAME && !k.revokedAt && (!k.expiresAt || Date.parse(k.expiresAt) > Date.now()));
    created = old
      ? await api.rotateApiKey(old.id, { graceHours: 0 })
      : await api.createApiKey({ name: KEY_NAME, permissions: ['search', 'call', 'complete'], spendCapUsd: deps.spendCapUsd });
  } catch (err) {
    throw new SetupError(`could not create the API key: ${(err as Error).message}`, 'key', { cause: err });
  }

  try {
    await n8n.createCredential({
      name: credName,
      type: CREDENTIAL_TYPE,
      data: { apiUrl: deps.gatewayUrlForN8n, apiKey: created.key, webhookSecret: randomBytes(24).toString('hex') },
    });
  } catch (err) {
    // Do not leave a key nobody can read: revoke it so the next attempt starts clean.
    await api.revokeApiKey(created.id).catch((e: unknown) => log?.warn(`setup: could not revoke key ${created.keyPrefix}…: ${(e as Error).message}`));
    throw new SetupError(`could not create the n8n credential: ${(err as N8nError | GatewayError).message}`, 'credential', { cause: err });
  }
  log?.info(`setup: ${dev.developerId} (${dev.handle}) now has a key and an n8n credential`);
  return session;
}

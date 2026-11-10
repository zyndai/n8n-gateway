// M4.2: n8n API key management for the dashboard. The plaintext is returned exactly once, on
// creation; only its SHA-256 hash and an 8-character prefix are stored (HLD > Security Model).
import { randomBytes } from 'node:crypto';
import { ApiError } from '../errors.js';
import { hashApiKey, type Permission } from '../middleware/apiKeyAuth.js';
import type { ApiKeyRow, ApiKeyStoreLike } from './ApiKeyStore.js';
import { parseUsd } from './money.js';

export const API_KEY_PERMISSIONS: readonly Permission[] = ['search', 'call', 'complete'];

/** Everything about a key except its hash. Safe to send to the browser. */
export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  spendCapUsd: string | null;
  spentUsd: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreatedApiKey extends ApiKeyView {
  /** The only time the plaintext exists outside the caller's n8n credential. */
  key: string;
}

/** M6.4: how long the old key keeps working after a rotation (hours). */
export const DEFAULT_ROTATION_GRACE_HOURS = 24;
export const MAX_ROTATION_GRACE_HOURS = 24 * 30;

export interface RotatedApiKey {
  /** The replacement. `key` is its plaintext, shown once. */
  created: CreatedApiKey;
  /** The old key, now expiring at `expiresAt`. */
  previous: ApiKeyView;
}

export interface ApiKeyServiceDeps {
  store: ApiKeyStoreLike;
  developerExists: (developerId: string) => Promise<boolean>;
  now?: () => Date;
}

export const toApiKeyView = (r: ApiKeyRow): ApiKeyView => ({
  id: r.id,
  name: r.name,
  keyPrefix: r.keyPrefix,
  permissions: r.permissions,
  spendCapUsd: r.spendCapUsd,
  spentUsd: r.spentUsd,
  expiresAt: r.expiresAt,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
  createdAt: r.createdAt,
});

export class ApiKeyService {
  private readonly now: () => Date;

  constructor(private readonly deps: ApiKeyServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async create(developerId: string, raw: unknown): Promise<CreatedApiKey> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError('BAD_REQUEST', 'Expected a JSON object');
    const body = raw as Record<string, unknown>;

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) throw new ApiError('BAD_REQUEST', 'name must be a non-empty string of at most 100 characters');

    let permissions: string[] = [...API_KEY_PERMISSIONS];
    if (body.permissions !== undefined) {
      const p = body.permissions;
      if (!Array.isArray(p) || p.length === 0 || p.some((x) => !API_KEY_PERMISSIONS.includes(x as Permission))) {
        throw new ApiError('BAD_REQUEST', `permissions must be a non-empty subset of ${API_KEY_PERMISSIONS.join(', ')}`);
      }
      permissions = [...new Set(p as string[])];
    }

    let spendCapUsd: string | null = null;
    if (body.spendCapUsd !== undefined && body.spendCapUsd !== null && body.spendCapUsd !== '') {
      if (typeof body.spendCapUsd !== 'string' && typeof body.spendCapUsd !== 'number') throw new ApiError('BAD_REQUEST', 'spendCapUsd must be a USD amount');
      if (parseUsd(body.spendCapUsd, 'spendCapUsd') === 0n) throw new ApiError('BAD_REQUEST', 'spendCapUsd must be greater than 0; leave it empty for no cap');
      spendCapUsd = String(body.spendCapUsd);
    }

    let expiresAt: Date | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== '') {
      const d = typeof body.expiresAt === 'string' ? new Date(body.expiresAt) : new Date(NaN);
      if (Number.isNaN(d.getTime())) throw new ApiError('BAD_REQUEST', 'expiresAt must be an ISO 8601 date');
      if (d.getTime() <= this.now().getTime()) throw new ApiError('BAD_REQUEST', 'expiresAt must be in the future');
      expiresAt = d;
    }

    if (!(await this.deps.developerExists(developerId))) throw new ApiError('NOT_FOUND', 'Developer not found');

    // 24 random bytes = 192 bits. The `zk_` prefix makes leaked keys greppable; the next 5
    // characters are random, so the 8-character display prefix still tells keys apart.
    const key = `zk_${randomBytes(24).toString('base64url')}`;
    const row = await this.deps.store.create({
      developerId,
      name,
      keyHash: hashApiKey(key),
      keyPrefix: key.slice(0, 8),
      permissions,
      spendCapUsd,
      expiresAt,
    });
    return { ...toApiKeyView(row), key };
  }

  async list(developerId: string): Promise<ApiKeyView[]> {
    return (await this.deps.store.listByDeveloper(developerId)).map(toApiKeyView);
  }

  /** Revoke. Idempotent; another developer's key answers 404 like any unknown id. */
  async revoke(developerId: string, id: string): Promise<ApiKeyView> {
    const row = await this.deps.store.revoke(developerId, id, this.now());
    if (!row) throw new ApiError('NOT_FOUND', 'API key not found');
    return toApiKeyView(row);
  }

  /**
   * M6.4: replace a key. The new key copies the old one's name, permissions, cap and spend so far,
   * and the old key stops working after `graceHours` (0 = at once), never later than it already would.
   * Both authenticate inside the window, so an n8n credential can be swapped without downtime.
   * The new key is stored first: a failure half-way leaves two working keys, never none. While the
   * window is open both keys spend, each against the cap, so total spend can overshoot by one cap.
   */
  async rotate(developerId: string, id: string, raw: unknown): Promise<RotatedApiKey> {
    const body = raw === undefined || raw === null ? {} : raw;
    if (typeof body !== 'object' || Array.isArray(body)) throw new ApiError('BAD_REQUEST', 'Expected a JSON object');
    const g = (body as Record<string, unknown>).graceHours;
    const graceHours = g === undefined ? DEFAULT_ROTATION_GRACE_HOURS : g;
    if (typeof graceHours !== 'number' || !Number.isFinite(graceHours) || graceHours < 0 || graceHours > MAX_ROTATION_GRACE_HOURS) {
      throw new ApiError('BAD_REQUEST', `graceHours must be a number between 0 and ${MAX_ROTATION_GRACE_HOURS}`);
    }

    const old = await this.deps.store.get(developerId, id);
    if (!old) throw new ApiError('NOT_FOUND', 'API key not found');
    const now = this.now();
    if (old.revokedAt || (old.expiresAt && old.expiresAt.getTime() <= now.getTime())) {
      throw new ApiError('CONFLICT', 'API key is revoked or expired and cannot be rotated; create a new one');
    }

    const key = `zk_${randomBytes(24).toString('base64url')}`;
    const row = await this.deps.store.create({
      developerId,
      name: old.name,
      keyHash: hashApiKey(key),
      keyPrefix: key.slice(0, 8),
      permissions: old.permissions,
      spendCapUsd: old.spendCapUsd,
      expiresAt: old.expiresAt, // the new key keeps the old key's own deadline, if it had one
      spentUsd: old.spentUsd,
    });

    const graceEnd = new Date(now.getTime() + graceHours * 3_600_000);
    const stopAt = old.expiresAt && old.expiresAt.getTime() < graceEnd.getTime() ? old.expiresAt : graceEnd;
    const previous = await this.deps.store.setExpiry(developerId, id, stopAt);
    if (!previous) throw new ApiError('NOT_FOUND', 'API key not found');
    return { created: { ...toApiKeyView(row), key }, previous: toApiKeyView(previous) };
  }
}
